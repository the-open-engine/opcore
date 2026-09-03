from mypy.plugin import Plugin

from .plugin_support import PLUGIN_MARKER


class OpcoreFixturePlugin(Plugin):
    marker = PLUGIN_MARKER


def plugin(version: str) -> type[Plugin]:
    return OpcoreFixturePlugin
