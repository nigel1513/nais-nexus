"""recipes.reader: bounded CSV/Parquet reads through CatalogReadPort, typing, errors without data values."""

import io

import pyarrow as pa
import pyarrow.parquet as pq
import pytest

from api.modules.catalog.public import StorageUnavailable, VersionView
from api.modules.workspace.recipes import reader as R
from api.modules.workspace.tests.fakes import FakeReader, file_ref
from api.platform.ids import new_id

CSV = b'\xef\xbb\xbfcell_id,temp,ok,when,note\nC-01, 25.5,true,2026-01-01,"multi\nline"\nC-02,40,false,2026-01-02,NA\nC-03,,TRUE,,x\n'


def parquet_bytes(table: pa.Table, row_group_size: int = 1000) -> bytes:
    buf = io.BytesIO()
    pq.write_table(table, buf, row_group_size=row_group_size)
    return buf.getvalue()


def version(*files: object) -> VersionView:
    return VersionView(
        dataset_version_id=new_id(),
        dataset_id=new_id(),
        owner_organization_id=new_id(),
        version_label="v1",
        status="PUBLISHED",
        manifest_sha256=None,
        metadata_snapshot={},
        files=tuple(files),  # type: ignore[arg-type]
    )


def test_primary_file_is_the_first_verified_tabular_file() -> None:
    readme = file_ref("README.md", b"x")
    pending = file_ref("a.csv", b"x", status="UPLOADED")
    data = file_ref("b.parquet", b"x")
    other = file_ref("c.csv", b"x")
    assert R.primary_file(version(readme, pending, data, other)) == data
    assert R.primary_file(version(readme)) is None


def test_csv_is_typed_after_reading() -> None:
    port = FakeReader()
    ref = port.add("data.csv", CSV)
    result = R.read_table(port, ref, max_rows=100, truncate=False)
    table = result.table
    assert table.column_names == ["cell_id", "temp", "ok", "when", "note"]  # BOM stripped
    assert table.schema.field("temp").type == pa.float64()
    assert table.schema.field("ok").type == pa.bool_()
    assert table.schema.field("when").type == pa.string()
    assert table.column("temp").to_pylist() == [25.5, 40.0, None]
    assert table.column("note").to_pylist() == ["multi\nline", None, "x"]
    assert result.truncated is False


def test_csv_row_cap_truncates_or_fails() -> None:
    port = FakeReader()
    body = b"n\n" + b"".join(b"%d\n" % i for i in range(5000))
    ref = port.add("big.csv", body)
    result = R.read_table(port, ref, max_rows=1000, truncate=True)
    assert (result.table.num_rows, result.truncated) == (1000, True)
    assert result.table.schema.field("n").type == pa.int64()
    with pytest.raises(R.InputTooLarge, match="1,000 rows"):
        R.read_table(port, ref, max_rows=1000, truncate=False)
    with pytest.raises(R.InputTooLarge, match="bytes"):
        R.read_table(port, ref, max_rows=10_000, truncate=False, max_bytes=100)


def test_malformed_csv_errors_do_not_quote_content() -> None:
    port = FakeReader()
    bad_row = port.add("bad.csv", b"a,b\n1,secret-token,3\n")
    with pytest.raises(R.InputUnreadable) as exc:
        R.read_table(port, bad_row, max_rows=10, truncate=False)
    assert "secret" not in str(exc.value)
    bad_utf8 = port.add("utf.csv", b"a,b\n1,\xff\n")
    with pytest.raises(R.InputUnreadable, match="UTF-8"):
        R.read_table(port, bad_utf8, max_rows=10, truncate=False)
    duplicate = port.add("dup.csv", b"a,a\n1,2\n")
    with pytest.raises(R.InputUnreadable, match="duplicate"):
        R.read_table(port, duplicate, max_rows=10, truncate=False)
    empty = port.add("empty.csv", b"")
    with pytest.raises(R.InputUnreadable):
        R.read_table(port, empty, max_rows=10, truncate=False)


def test_header_only_csv_is_an_empty_table() -> None:
    port = FakeReader()
    ref = port.add("h.csv", b"a,b\n")
    table = R.read_table(port, ref, max_rows=10, truncate=False).table
    assert (table.column_names, table.num_rows) == (["a", "b"], 0)


def test_parquet_keeps_its_types_and_decodes_dictionaries() -> None:
    source = pa.table(
        {
            "k": pa.array(["a", "b", "a"]).dictionary_encode(),
            "v": pa.array([1, 2, 3], pa.int32()),
        }
    )
    port = FakeReader()
    ref = port.add("t.parquet", parquet_bytes(source, row_group_size=2))
    table = R.read_table(port, ref, max_rows=10, truncate=False).table
    assert table.schema.field("k").type == pa.string()
    assert table.schema.field("v").type == pa.int32()
    assert table.column("k").to_pylist() == ["a", "b", "a"]
    assert all(r is not None for _, r in port.opened)  # ranged reads only, never the whole object
    truncated = R.read_table(port, ref, max_rows=2, truncate=True)
    assert (truncated.table.num_rows, truncated.truncated) == (2, True)
    with pytest.raises(R.InputTooLarge):
        R.read_table(port, ref, max_rows=2, truncate=False)


def test_corrupt_parquet_and_storage_failures() -> None:
    port = FakeReader()
    ref = port.add("broken.parquet", b"PAR1" + b"\x00" * 100 + b"PAR1")
    with pytest.raises(R.InputUnreadable, match="Parquet"):
        R.read_table(port, ref, max_rows=10, truncate=False)
    good = port.add("ok.csv", b"a\n1\n")
    port.fail_with = StorageUnavailable("down")
    with pytest.raises(StorageUnavailable):
        R.read_table(port, good, max_rows=10, truncate=False)


def test_deadline_stops_reading() -> None:
    port = FakeReader()
    ref = port.add("slow.csv", b"a\n" + b"1\n" * 10)

    def expired() -> None:
        raise R.ReadTimeout()

    with pytest.raises(R.ReadTimeout):
        R.read_table(port, ref, max_rows=100, truncate=False, deadline=expired)


def test_schema_cache_reads_a_file_once() -> None:
    port = FakeReader()
    ref = port.add("c.csv", b"a,b\n1,x\n")
    cache = R.SchemaCache(size=2)
    first = cache.schema(port, ref)
    opened = len(port.opened)
    assert cache.schema(port, ref) == first
    assert len(port.opened) == opened
    assert first.field("a").type == pa.int64()


def test_csv_typing_keeps_identifiers_as_text() -> None:
    port = FakeReader()
    body = (
        b"zip,code,big,plus,neg,zero,dec,lead_dec,flag\n"
        b"007,01234,12345678901234567890,+5,-3,0,1.50,00.5,TRUE\n"
        b"10,5,1,6,4,0,0.5,1.0,false\n"
    )
    table = R.read_table(port, port.add("ids.csv", body), max_rows=10, truncate=False).table
    types = {f.name: f.type for f in table.schema}
    assert types == {
        "zip": pa.string(),
        "code": pa.string(),
        "big": pa.string(),  # beyond int64: never a float
        "plus": pa.string(),
        "neg": pa.int64(),
        "zero": pa.int64(),
        "dec": pa.float64(),
        "lead_dec": pa.string(),
        "flag": pa.bool_(),
    }
    assert table.column("zip").to_pylist() == ["007", "10"]
    assert table.column("big").to_pylist() == ["12345678901234567890", "1"]


@pytest.mark.parametrize(
    "values",
    [
        ["12345678901234567890", "1.5"],  # beyond int64 next to a decimal
        ["9007199254740993", "1.5"],  # within int64, not exact in float64
        ["0.12345678901234567891", "1.5"],  # more digits than float64 keeps
    ],
)
def test_float_columns_must_be_exact(values: list[str]) -> None:
    port = FakeReader()
    body = ("x\n" + "\n".join(values) + "\n").encode()
    table = R.read_table(port, port.add("f.csv", body), max_rows=10, truncate=False).table
    assert table.schema.field("x").type == pa.string()
    assert table.column("x").to_pylist() == values


def test_exact_long_decimals_are_still_floats() -> None:
    port = FakeReader()
    values = ["0.1", "1.50", "1e3", "123456789012345", "0.30000000000000004", "9007199254740992"]
    body = ("x\n" + "\n".join([*values, "2.5"]) + "\n").encode()
    table = R.read_table(port, port.add("g.csv", body), max_rows=10, truncate=False).table
    assert table.schema.field("x").type == pa.float64()
    assert table.column("x").to_pylist()[:4] == [0.1, 1.5, 1000.0, 123456789012345.0]
