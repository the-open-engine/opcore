from .helpers import build_name


def trace(func):
    return func


@trace
async def load_name():
    def inner():
        return build_name()

    return inner()
