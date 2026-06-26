from .base import BaseModel
from .helpers import build_name
from .missing import MissingLocal

_private = 1
__all__ = ["PublicModel", "make_model"]


class PublicModel(BaseModel):
    @classmethod
    def from_value(cls):
        return build_name()

    def render(self):
        return build_name()


def make_model():
    return PublicModel()


def _hidden():
    return PublicModel()
