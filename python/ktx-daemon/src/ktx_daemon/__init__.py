"""Portable compute package for ktx."""

from collections.abc import Callable
from importlib.metadata import PackageNotFoundError, version

PACKAGE_NAME = "ktx-daemon"
RUNTIME_DISTRIBUTION_NAME = "kaelio-ktx"


def resolve_package_version(
    version_loader: Callable[[str], str] = version,
) -> str:
    for distribution_name in (RUNTIME_DISTRIBUTION_NAME, PACKAGE_NAME):
        try:
            return version_loader(distribution_name)
        except PackageNotFoundError:
            continue
    return "0.0.0+local"


VERSION = resolve_package_version()

__all__ = [
    "PACKAGE_NAME",
    "RUNTIME_DISTRIBUTION_NAME",
    "VERSION",
    "resolve_package_version",
]
