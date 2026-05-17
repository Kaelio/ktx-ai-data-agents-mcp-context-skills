from ktx_daemon import PACKAGE_NAME, VERSION, resolve_package_version


def test_package_metadata() -> None:
    assert PACKAGE_NAME == "ktx-daemon"
    assert VERSION == resolve_package_version()


def test_package_version_prefers_bundled_runtime_distribution() -> None:
    calls: list[str] = []

    def fake_version(distribution_name: str) -> str:
        calls.append(distribution_name)
        if distribution_name == "kaelio-ktx":
            return "0.1.0rc1"
        raise AssertionError(f"unexpected distribution lookup: {distribution_name}")

    assert resolve_package_version(version_loader=fake_version) == "0.1.0rc1"
    assert calls == ["kaelio-ktx"]
