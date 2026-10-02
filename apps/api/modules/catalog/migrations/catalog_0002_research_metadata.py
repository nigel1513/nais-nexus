"""catalog research metadata (Wave 1.5 spec §3.1, §3.2): vocabulary, dataset research columns, contributors

Revision ID: catalog_0002
Revises: catalog_0001
"""

import sqlalchemy as sa
from alembic import op
from api.modules.catalog.vocabulary_seed import SEED_TERMS
from sqlalchemy.dialects.postgresql import ARRAY, JSONB, UUID

revision = "catalog_0002"
down_revision = "catalog_0001"
branch_labels = None
depends_on = None

S = "catalog"
CODE = "^[A-Z0-9_]{2,64}$"
EMPTY = sa.text("'{}'::text[]")


def upgrade() -> None:
    terms = op.create_table(
        "vocabulary_terms",
        sa.Column(
            "term_id", UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")
        ),
        sa.Column("scheme", sa.Text, nullable=False),
        sa.Column("code", sa.Text, nullable=False),
        sa.Column("label_ko", sa.Text, nullable=False),
        sa.Column("label_en", sa.Text, nullable=False),
        sa.Column("iri", sa.Text, nullable=True),
        sa.Column("parent_code", sa.Text, nullable=True),
        sa.Column("active", sa.Boolean, nullable=False, server_default=sa.true()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.UniqueConstraint("scheme", "code", name="uq_vocabulary_scheme_code"),
        sa.CheckConstraint("scheme IN ('SUBJECT','METHOD','MATERIAL')", name="ck_vocabulary_scheme"),
        sa.CheckConstraint(f"code ~ '{CODE}'", name="ck_vocabulary_code"),
        sa.CheckConstraint("iri IS NULL OR iri ~ '^https?://[^[:space:]]+$'", name="ck_vocabulary_iri"),
        schema=S,
    )
    op.bulk_insert(
        terms,
        [
            {"scheme": s, "code": c, "label_ko": ko, "label_en": en, "parent_code": parent}
            for s, c, ko, en, parent in SEED_TERMS
        ],
    )
    for column in (
        sa.Column("subtitle", sa.Text, nullable=True),
        sa.Column("principal_investigator_id", UUID(as_uuid=True), nullable=True),
        sa.Column("principal_investigator_org_id", UUID(as_uuid=True), nullable=True),
        sa.Column("data_steward_contact_id", UUID(as_uuid=True), nullable=True),
        sa.Column("data_steward_contact_org_id", UUID(as_uuid=True), nullable=True),
        sa.Column("contact_email_public", sa.Boolean, nullable=False, server_default=sa.false()),
        sa.Column("project_title", sa.Text, nullable=True),
        sa.Column("project_code", sa.Text, nullable=True),
        sa.Column("funding_agency", sa.Text, nullable=True),
        sa.Column("subject_codes", ARRAY(sa.Text), nullable=False, server_default=EMPTY),
        sa.Column("method_codes", ARRAY(sa.Text), nullable=False, server_default=EMPTY),
        sa.Column("material_codes", ARRAY(sa.Text), nullable=False, server_default=EMPTY),
        sa.Column("method_detail", sa.Text, nullable=True),
        sa.Column("temporal_start", sa.Date, nullable=True),
        sa.Column("temporal_end", sa.Date, nullable=True),
        sa.Column("collecting_organization_id", UUID(as_uuid=True), nullable=True),
        sa.Column("collecting_organization_name", sa.Text, nullable=True),
        sa.Column("update_frequency", sa.Text, nullable=False, server_default="ONCE"),
        sa.Column("related_publications", JSONB, nullable=False, server_default=sa.text("'[]'::jsonb")),
        sa.Column("doi", sa.Text, nullable=True),
    ):
        op.add_column("datasets", column, schema=S)
    for name, condition in (
        ("ck_datasets_subtitle", "subtitle IS NULL OR char_length(subtitle) <= 160"),
        ("ck_datasets_project_title", "project_title IS NULL OR char_length(project_title) <= 300"),
        ("ck_datasets_project_code", "project_code IS NULL OR char_length(project_code) <= 64"),
        ("ck_datasets_funding_agency", "funding_agency IS NULL OR char_length(funding_agency) <= 200"),
        ("ck_datasets_subject_codes", "cardinality(subject_codes) <= 5"),
        ("ck_datasets_method_codes", "cardinality(method_codes) <= 10"),
        ("ck_datasets_material_codes", "cardinality(material_codes) <= 20"),
        ("ck_datasets_method_detail", "method_detail IS NULL OR char_length(method_detail) <= 4000"),
        (
            "ck_datasets_temporal",
            "temporal_end IS NULL OR temporal_start IS NULL OR temporal_end >= temporal_start",
        ),
        (
            "ck_datasets_collecting_org",
            "collecting_organization_id IS NULL OR collecting_organization_name IS NULL",
        ),
        (
            "ck_datasets_collecting_name",
            "collecting_organization_name IS NULL OR char_length(collecting_organization_name) BETWEEN 1 AND 200",
        ),
        (
            "ck_datasets_update_frequency",
            "update_frequency IN ('ONCE','MONTHLY','QUARTERLY','YEARLY','IRREGULAR')",
        ),
        (
            "ck_datasets_publications",
            "jsonb_typeof(related_publications) = 'array' AND jsonb_array_length(related_publications) <= 20",
        ),
        (
            "ck_datasets_pi_org",
            "(principal_investigator_id IS NULL) = (principal_investigator_org_id IS NULL)",
        ),
        (
            "ck_datasets_steward_org",
            "(data_steward_contact_id IS NULL) = (data_steward_contact_org_id IS NULL)",
        ),
    ):
        op.create_check_constraint(name, "datasets", condition, schema=S)
    op.create_index("ix_datasets_pi", "datasets", ["principal_investigator_id"], schema=S)
    op.create_table(
        "dataset_contributors",
        sa.Column(
            "dataset_id", UUID(as_uuid=True), sa.ForeignKey("catalog.datasets.dataset_id"), nullable=False
        ),
        sa.Column("user_id", UUID(as_uuid=True), nullable=False),
        sa.Column("role", sa.Text, nullable=False),
        sa.Column("affiliation_organization_id", UUID(as_uuid=True), nullable=False),
        sa.Column("position", sa.Integer, nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.PrimaryKeyConstraint("dataset_id", "user_id", "role", name="pk_dataset_contributors"),
        sa.CheckConstraint(
            "role IN ('CO_INVESTIGATOR','DATA_COLLECTOR','DATA_CURATOR')", name="ck_contributors_role"
        ),
        schema=S,
    )


def downgrade() -> None:
    op.drop_table("dataset_contributors", schema=S)
    op.drop_index("ix_datasets_pi", "datasets", schema=S)
    for name in (
        "ck_datasets_subtitle",
        "ck_datasets_project_title",
        "ck_datasets_project_code",
        "ck_datasets_funding_agency",
        "ck_datasets_subject_codes",
        "ck_datasets_method_codes",
        "ck_datasets_material_codes",
        "ck_datasets_method_detail",
        "ck_datasets_temporal",
        "ck_datasets_collecting_org",
        "ck_datasets_collecting_name",
        "ck_datasets_update_frequency",
        "ck_datasets_publications",
        "ck_datasets_pi_org",
        "ck_datasets_steward_org",
    ):
        op.drop_constraint(name, "datasets", schema=S, type_="check")
    for column in (
        "subtitle",
        "principal_investigator_id",
        "principal_investigator_org_id",
        "data_steward_contact_id",
        "data_steward_contact_org_id",
        "contact_email_public",
        "project_title",
        "project_code",
        "funding_agency",
        "subject_codes",
        "method_codes",
        "material_codes",
        "method_detail",
        "temporal_start",
        "temporal_end",
        "collecting_organization_id",
        "collecting_organization_name",
        "update_frequency",
        "related_publications",
        "doi",
    ):
        op.drop_column("datasets", column, schema=S)
    op.drop_table("vocabulary_terms", schema=S)
