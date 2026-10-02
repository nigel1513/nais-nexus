"""ModuleSpec.wire(): build the default NotesDeps and register it."""

from api.modules.notes.adapters import IdentityDisplayNames
from api.modules.notes.deps import NotesDeps
from api.modules.notes.settings import NotesSettings, get_notes_settings
from api.platform import ports


def build_default_deps(settings: NotesSettings | None = None) -> NotesDeps:
    return NotesDeps(settings=settings or get_notes_settings(), people=IdentityDisplayNames())


def install(deps: NotesDeps) -> None:
    ports.provide(NotesDeps, deps)


def wire() -> None:
    install(build_default_deps())
