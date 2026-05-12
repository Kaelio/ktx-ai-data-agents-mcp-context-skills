from __future__ import annotations

import pytest

from semantic_layer.engine import SemanticEngine
from semantic_layer.models import (
    JoinDeclaration,
    SourceColumn,
    SourceDefinition,
)


def _src(
    name: str,
    columns: list[str] | None = None,
    grain: list[str] | None = None,
    joins: list[JoinDeclaration] | None = None,
) -> SourceDefinition:
    """Minimal-boilerplate source factory for validator tests."""
    columns = columns or ["id"]
    grain = grain or ["id"]
    return SourceDefinition(
        name=name,
        table=f"public.{name}",
        grain=grain,
        columns=[SourceColumn(name=c, type="number") for c in columns],
        joins=joins or [],
    )


class TestValidatorValid:
    def test_valid_connected_model(self):
        orders = _src(
            "orders",
            columns=["id", "customer_id"],
            joins=[
                JoinDeclaration(
                    to="customers",
                    on="customer_id = customers.id",
                    relationship="many_to_one",
                )
            ],
        )
        customers = _src("customers")
        engine = SemanticEngine.from_sources({"orders": orders, "customers": customers})

        report = engine.validate()

        assert report.valid
        assert report.errors == []
        assert report.warnings == []


class TestOrphanJoinTarget:
    def test_orphan_join_target_is_error(self):
        orders = _src(
            "orders",
            columns=["id", "customer_id"],
            joins=[
                JoinDeclaration(
                    to="customers",
                    on="customer_id = customers.id",
                    relationship="many_to_one",
                )
            ],
        )
        # `customers` deliberately not defined
        engine = SemanticEngine.from_sources({"orders": orders})

        report = engine.validate()

        assert not report.valid
        assert any(
            "orders" in e and "customers" in e and "not defined" in e
            for e in report.errors
        )

    def test_query_with_orphan_target_raises_before_sql(self):
        """Query path must reject orphan targets, not silently emit SQL
        that references the undefined table name (which could read a real
        unmodeled table sharing that name)."""
        orders = _src(
            "orders",
            columns=["id", "amount", "customer_id"],
            joins=[
                JoinDeclaration(
                    to="customers",
                    on="customer_id = customers.id",
                    relationship="many_to_one",
                )
            ],
        )
        engine = SemanticEngine.from_sources({"orders": orders})

        with pytest.raises(ValueError) as exc:
            engine.query(
                {
                    "measures": ["sum(orders.amount)"],
                    "dimensions": ["customers.id"],
                }
            )
        msg = str(exc.value)
        assert "orders" in msg
        assert "customers" in msg
        assert "not defined" in msg


class TestInvalidGrain:
    def test_grain_column_missing_from_columns(self):
        bad = _src(
            "bad",
            columns=["id"],
            grain=["nonexistent_col"],
        )
        engine = SemanticEngine.from_sources({"bad": bad})

        report = engine.validate()

        assert not report.valid
        assert any("bad" in e and "nonexistent_col" in e for e in report.errors)

    def test_qualified_grain_name_is_rejected(self):
        bad = _src(
            "activity",
            columns=["account_id"],
            grain=["activity.account_id"],
        )
        engine = SemanticEngine.from_sources({"activity": bad})

        report = engine.validate()

        assert not report.valid
        assert any(
            "activity" in e and "activity.account_id" in e and "qualified" in e
            for e in report.errors
        )

    def test_qualified_column_name_is_rejected(self):
        bad = SourceDefinition(
            name="activity",
            table="public.activity",
            grain=["account_id"],
            columns=[
                SourceColumn(name="account_id", type="number"),
                SourceColumn(name="activity.user_id", type="number"),
            ],
        )
        engine = SemanticEngine.from_sources({"activity": bad})

        report = engine.validate()

        assert not report.valid
        assert any(
            "activity" in e and "activity.user_id" in e and "unqualified" in e
            for e in report.errors
        )

    def test_sql_source_grain_missing_from_projection(self):
        bad = SourceDefinition(
            name="large_contract_requesters",
            sql=(
                "select account.account_name, requester.email as requester_email "
                "from orbit_raw.actions activity "
                "join orbit_raw.accounts account "
                "  on account.account_id = activity.account_id "
                "join orbit_raw.users requester "
                "  on requester.user_id = activity.user_id"
            ),
            grain=["account_id", "user_id"],
            columns=[
                SourceColumn(name="account_id", type="number"),
                SourceColumn(name="user_id", type="number"),
                SourceColumn(name="account_name", type="string"),
                SourceColumn(name="requester_email", type="string"),
            ],
        )
        engine = SemanticEngine.from_sources({"large_contract_requesters": bad})

        report = engine.validate()

        assert not report.valid
        assert any(
            "large_contract_requesters" in e
            and "account_id" in e
            and "SELECT projection" in e
            for e in report.errors
        )

    def test_sql_source_grain_in_projection_passes(self):
        good = SourceDefinition(
            name="contract_requesters",
            sql=(
                "select activity.account_id, activity.user_id, "
                "account.account_name, requester.email as requester_email "
                "from orbit_raw.actions activity "
                "join orbit_raw.accounts account "
                "  on account.account_id = activity.account_id "
                "join orbit_raw.users requester "
                "  on requester.user_id = activity.user_id"
            ),
            grain=["account_id", "user_id"],
            columns=[
                SourceColumn(name="account_id", type="number"),
                SourceColumn(name="user_id", type="number"),
                SourceColumn(name="account_name", type="string"),
                SourceColumn(name="requester_email", type="string"),
            ],
        )
        engine = SemanticEngine.from_sources({"contract_requesters": good})

        report = engine.validate()

        # No grain-related errors. (Other validators may emit unrelated
        # warnings — we just assert the grain check is clean.)
        assert not any("grain" in e or "SELECT projection" in e for e in report.errors)

    def test_sql_source_with_select_star_skips_projection_check(self):
        # SELECT * means we can't statically know projected columns;
        # the projection check must skip rather than false-fail.
        src = SourceDefinition(
            name="opaque",
            sql="select * from public.events",
            grain=["event_id"],
            columns=[SourceColumn(name="event_id", type="number")],
        )
        engine = SemanticEngine.from_sources({"opaque": src})

        report = engine.validate()

        assert not any("SELECT projection" in e for e in report.errors)


class TestJoinValidation:
    def test_join_local_column_must_exist(self):
        orders = _src(
            "orders",
            columns=["id"],
            joins=[
                JoinDeclaration(
                    to="customers",
                    on="customer_id = customers.id",
                    relationship="many_to_one",
                )
            ],
        )
        customers = _src("customers")
        engine = SemanticEngine.from_sources({"orders": orders, "customers": customers})

        report = engine.validate()

        assert not report.valid
        assert any(
            "orders" in e and "customer_id" in e and "columns list" in e
            for e in report.errors
        )

    def test_many_to_one_join_rejects_display_name_to_id_grain(self):
        requesters = _src(
            "large_contract_requesters",
            columns=["account_name", "requester_email"],
            grain=["requester_email"],
            joins=[
                JoinDeclaration(
                    to="mart_account_segments",
                    on="account_name = mart_account_segments.account_id",
                    relationship="many_to_one",
                )
            ],
        )
        accounts = _src(
            "mart_account_segments",
            columns=["account_id", "account_name"],
            grain=["account_id"],
        )
        engine = SemanticEngine.from_sources(
            {
                "large_contract_requesters": requesters,
                "mart_account_segments": accounts,
            }
        )

        report = engine.validate()

        assert not report.valid
        assert any(
            "large_contract_requesters" in e
            and "account_name" in e
            and "mart_account_segments.account_id" in e
            for e in report.errors
        )

    def test_sql_join_coverage_does_not_require_join_without_projected_key(self):
        requesters = SourceDefinition(
            name="large_contract_requesters",
            sql="""
                select accounts.account_name, users.email as requester_email
                from orbit_raw.requests requests
                join public.mart_account_segments accounts
                  on requests.account_id = accounts.account_id
                join orbit_raw.users users
                  on requests.user_id = users.user_id
            """,
            grain=["requester_email"],
            columns=[
                SourceColumn(name="account_name", type="string"),
                SourceColumn(name="requester_email", type="string"),
            ],
            joins=[],
        )
        accounts = _src(
            "mart_account_segments",
            columns=["account_id", "account_name"],
            grain=["account_id"],
        )
        engine = SemanticEngine.from_sources(
            {
                "large_contract_requesters": requesters,
                "mart_account_segments": accounts,
            }
        )

        report = engine.validate(recently_touched={"large_contract_requesters"})

        assert report.errors == []

    def test_sql_join_coverage_does_not_treat_unrelated_id_suffix_as_id_key(self):
        requesters = SourceDefinition(
            name="large_contract_requesters",
            sql="""
                select accounts.account_name, requests.user_id
                from orbit_raw.requests requests
                join public.accounts accounts
                  on requests.account_id = accounts.id
            """,
            grain=["user_id"],
            columns=[
                SourceColumn(name="account_name", type="string"),
                SourceColumn(name="user_id", type="string"),
            ],
            joins=[],
        )
        accounts = _src("accounts", columns=["id", "account_name"], grain=["id"])
        engine = SemanticEngine.from_sources(
            {
                "large_contract_requesters": requesters,
                "accounts": accounts,
            }
        )

        report = engine.validate(recently_touched={"large_contract_requesters"})

        assert report.errors == []

    def test_sql_join_coverage_requires_join_when_projected_key_exists(self):
        requesters = SourceDefinition(
            name="large_contract_requesters",
            sql="""
                select accounts.account_id, users.email as requester_email
                from orbit_raw.requests requests
                join public.mart_account_segments accounts
                  on requests.account_id = accounts.account_id
                join orbit_raw.users users
                  on requests.user_id = users.user_id
            """,
            grain=["requester_email"],
            columns=[
                SourceColumn(name="account_id", type="string"),
                SourceColumn(name="requester_email", type="string"),
            ],
            joins=[],
        )
        accounts = _src(
            "mart_account_segments",
            columns=["account_id", "account_name"],
            grain=["account_id"],
        )
        engine = SemanticEngine.from_sources(
            {
                "large_contract_requesters": requesters,
                "mart_account_segments": accounts,
            }
        )

        report = engine.validate(recently_touched={"large_contract_requesters"})

        assert not report.valid
        assert any(
            "mart_account_segments" in e and "joins[]" in e for e in report.errors
        )


class TestDisconnectedComponents:
    def test_two_components_produce_warning_not_error(self):
        a = _src("a")
        b = _src("b")
        engine = SemanticEngine.from_sources({"a": a, "b": b})

        report = engine.validate()

        assert report.valid
        assert report.errors == []
        assert len(report.warnings) >= 1
        disconnection = next(
            (w for w in report.warnings if "disconnected components" in w), None
        )
        assert disconnection is not None
        assert "2 disconnected components" in disconnection
        assert "Component 1" in disconnection
        assert "Component 2" in disconnection

    def test_aliases_do_not_create_false_disconnection(self):
        """Two aliases of the same base source must count as one component
        with the base, not as separate islands."""
        orders = SourceDefinition(
            name="orders",
            table="public.orders",
            grain=["id"],
            columns=[
                SourceColumn(name="id", type="number"),
                SourceColumn(name="amount", type="number"),
                SourceColumn(name="billing_customer_id", type="number"),
                SourceColumn(name="shipping_customer_id", type="number"),
            ],
            joins=[
                JoinDeclaration(
                    to="customers",
                    alias="billing_customer",
                    on="billing_customer_id = billing_customer.id",
                    relationship="many_to_one",
                ),
                JoinDeclaration(
                    to="customers",
                    alias="shipping_customer",
                    on="shipping_customer_id = shipping_customer.id",
                    relationship="many_to_one",
                ),
            ],
        )
        customers = _src("customers", columns=["id", "segment"])
        engine = SemanticEngine.from_sources({"orders": orders, "customers": customers})

        report = engine.validate()

        assert report.valid
        assert not any("disconnected components" in w for w in report.warnings)

    def test_large_component_is_truncated(self):
        many = {f"s{i}": _src(f"s{i}") for i in range(10)}
        # Join them sequentially so they form one big component
        for i in range(9):
            many[f"s{i}"].joins.append(
                JoinDeclaration(
                    to=f"s{i + 1}",
                    on=f"id = s{i + 1}.id",
                    relationship="many_to_one",
                )
            )
        many["island"] = _src("island")
        engine = SemanticEngine.from_sources(many)

        report = engine.validate()

        disconnection = next(
            w for w in report.warnings if "disconnected components" in w
        )
        assert "(10 sources)" in disconnection
        assert "... (+8 more)" in disconnection
        assert "(1 sources): island" in disconnection

    def test_singleton_component_warning_names_recently_touched_source(self):
        orders = _src(
            "orders",
            columns=["id", "customer_id"],
            joins=[
                JoinDeclaration(
                    to="customers",
                    on="customer_id = customers.id",
                    relationship="many_to_one",
                )
            ],
        )
        customers = _src("customers")
        lonely_source = _src("lonely_source")
        engine = SemanticEngine.from_sources(
            {
                "orders": orders,
                "customers": customers,
                "lonely_source": lonely_source,
            }
        )

        report = engine.validate(recently_touched={"lonely_source"})

        assert report.per_source_warnings["lonely_source"]
        msg = report.per_source_warnings["lonely_source"][0]
        assert "lonely_source" in msg
        assert "singleton" in msg.lower() or "no joins" in msg.lower()

    def test_no_per_source_warning_for_connected_recently_touched_source(self):
        orders = _src(
            "orders",
            columns=["id", "customer_id"],
            joins=[
                JoinDeclaration(
                    to="customers",
                    on="customer_id = customers.id",
                    relationship="many_to_one",
                )
            ],
        )
        customers = _src("customers")
        engine = SemanticEngine.from_sources({"orders": orders, "customers": customers})

        report = engine.validate(recently_touched={"orders"})

        assert report.per_source_warnings.get("orders", []) == []

    def test_recently_touched_default_none_preserves_existing_behavior(self):
        lonely = _src("lonely")
        other = _src("other")
        engine = SemanticEngine.from_sources({"lonely": lonely, "other": other})

        report = engine.validate()

        assert any("disconnected components" in w for w in report.warnings)
        assert report.per_source_warnings == {}


class TestEcommerceSmoke:
    def test_ecommerce_fixtures_validate_cleanly(self, ecommerce_sources):
        engine = SemanticEngine.from_sources(ecommerce_sources)

        report = engine.validate()

        assert report.valid, f"Expected clean report, got errors: {report.errors}"
        assert report.warnings == [], f"Expected no warnings, got: {report.warnings}"


class TestMultipleIssuesCollected:
    def test_errors_and_warnings_coexist(self):
        bad_grain = _src("bad_grain", columns=["id"], grain=["missing"])
        orphan_target = _src(
            "with_orphan",
            columns=["id", "fk"],
            joins=[
                JoinDeclaration(
                    to="doesnt_exist",
                    on="fk = doesnt_exist.id",
                    relationship="many_to_one",
                )
            ],
        )
        isolated = _src("isolated")
        engine = SemanticEngine.from_sources(
            {
                "bad_grain": bad_grain,
                "with_orphan": orphan_target,
                "isolated": isolated,
            }
        )

        report = engine.validate()

        assert not report.valid
        assert len(report.errors) >= 2
        assert any("missing" in e for e in report.errors)
        assert any("doesnt_exist" in e for e in report.errors)
        assert len(report.warnings) >= 1
