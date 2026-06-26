from src.pkg import PACKAGE_VALUE
from src.pkg.models import PublicModel, make_model


def test_make_model():
    make_model()
    PublicModel.from_value()
    return PACKAGE_VALUE


class TestPublicModel:
    def test_render(self):
        return PublicModel().render()
