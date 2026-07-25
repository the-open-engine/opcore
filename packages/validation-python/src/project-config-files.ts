export const pythonBoundaryFileNames = [
  "pyproject.toml", "Pipfile", "Pipfile.lock", "poetry.lock", "pdm.lock", "uv.lock", "setup.cfg", "setup.py", "pytest.ini", "tox.ini"
] as const;

const pythonToolConfigFileNames = [
  "pyrightconfig.json", "ruff.toml", ".ruff.toml", "mypy.ini", ".mypy.ini", "pytest.ini", "tox.ini"
] as const;

export function isRelevantPythonConfig(path: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return pythonBoundaryFileNames.includes(name as (typeof pythonBoundaryFileNames)[number]) ||
    name === "conftest.py" ||
    /^requirements.*\.txt$/u.test(name) ||
    pythonToolConfigFileNames.includes(name as (typeof pythonToolConfigFileNames)[number]);
}
