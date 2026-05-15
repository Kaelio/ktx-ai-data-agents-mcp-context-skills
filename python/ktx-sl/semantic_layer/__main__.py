from __future__ import annotations

import json
import sys

from semantic_layer.cli import main as cli_main
from semantic_layer.models import SourceDefinition


def dump_schema() -> None:
    json.dump(
        SourceDefinition.model_json_schema(), sys.stdout, indent=2, sort_keys=True
    )
    sys.stdout.write("\n")


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] in {"dump-schema", "schema"}:
        sys.argv.pop(1)
        dump_schema()
    else:
        cli_main()
