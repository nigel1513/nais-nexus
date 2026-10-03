"""ModuleSpec.wire(): build the default NotesDeps and register it, and make the shared Jupyter the notebook source when
NAIS_JUPYTER_URL is set (otherwise NotesDeps.notebooks falls back to NoNotebooks)."""

from api.modules.notes.adapters import IdentityDisplayNames, JupyterNotebooks
from api.modules.notes.deps import NotesDeps
from api.modules.notes.interfaces import NotebookActivityPort
from api.modules.notes.settings import NotesSettings, get_notes_settings
from api.platform import ports
from api.platform.jupyter import get_jupyter_client
from api.platform.settings import Settings, get_settings


def build_default_deps(settings: NotesSettings | None = None) -> NotesDeps:
    return NotesDeps(settings=settings or get_notes_settings(), people=IdentityDisplayNames())


def install(deps: NotesDeps) -> None:
    ports.provide(NotesDeps, deps)


def provide_notebooks(settings: Settings) -> None:
    client = get_jupyter_client(settings)
    if client is not None:
        ports.provide(NotebookActivityPort, JupyterNotebooks(client))


def wire() -> None:
    install(build_default_deps())
    provide_notebooks(get_settings())
