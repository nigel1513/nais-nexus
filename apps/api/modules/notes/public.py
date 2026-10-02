"""M14 research-notes public interface. Other modules import only this file; they never read notes.* tables.
Leaf: stdlib/typing only.

Nothing is exported yet: notes consume other modules' events (evidence, Task 10) and expose everything else through
the HTTP contract. Audit and notifications follow the notes.note.*.v1 events.
"""

__all__: list[str] = []
