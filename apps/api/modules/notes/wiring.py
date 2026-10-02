"""ModuleSpec.wire(): build the default NotesDeps and register it."""

from api.modules.notes.adapters import IdentityDisplayNames, NoNotebooks
from api.modules.notes.deps import NotesDeps
from api.modules.notes.interfaces import NotebookActivityPort
from api.modules.notes.settings import NotesSettings, get_notes_settings
from api.platform import ports


def build_default_deps(settings: NotesSettings | None = None) -> NotesDeps:
    return NotesDeps(settings=settings or get_notes_settings(), people=IdentityDisplayNames())


def install(deps: NotesDeps) -> None:
    ports.provide(NotesDeps, deps)


def provide_default_notebooks() -> None:
    """NoNotebooks as the NotebookActivityPort unless M07 (wired earlier) already provided the real one; M07 wired
    later simply replaces it with ports.provide."""
    try:
        ports.get(NotebookActivityPort)
    except ports.PortNotProvided:
        ports.provide(NotebookActivityPort, NoNotebooks())


def wire() -> None:
    install(build_default_deps())
    provide_default_notebooks()
