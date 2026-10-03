"""Local-LLM drafting of research notes: prompt (prompt.py) -> answer parsing (parse.py) -> AI blocks (apply.py).

Only the recorder's notebooks of the day reach the model, as cell source heads and output kinds/counts; never output
values, file contents or row values, and never the workspace activity evidence.
"""
