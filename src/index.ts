import { mkdir } from "node:fs/promises";
import { connector } from "@dbml/connector";
import { importer } from "@dbml/core";
import type Field from "@dbml/core/types/model_structure/field";
import { match } from "ts-pattern";

if (!Bun.env.DATABASE_URL) {
  throw new Error("DATABASE_URL environment variable is not set");
}

const connection = Bun.env.DATABASE_URL;
const databaseType = "postgres";

const schemaJson = await connector.fetchSchemaJson(connection, databaseType);

console.log(JSON.stringify(schemaJson, null, 2));
const dbml = importer.generateDbml(schemaJson);

await mkdir("output", { recursive: true });
Bun.write("output/schema.json", JSON.stringify(schemaJson, null, 2));
Bun.write("output/schema.dbml", dbml);

const file = Bun.file("output/result.md");
await file.delete().catch(() => {});
const writer = file.writer();

[
  "```mermaid",
  "---",
  "config:",
  "  layout: elk",
  "---",
  "erDiagram",
  "",
].forEach((line) => {
  writer.write(`${line}\n`);
});

const omitTables = new Set(["spatial_ref_sys"]);

for (const table of schemaJson.tables) {
  const tableName = table.name;
  const schema = table.schemaName || "public";

  const tableIndex = `${schema}.${tableName}`;

  if (omitTables.has(tableName)) {
    continue;
  }

  writer.write(`${table.name} {\n`);
  const fields = (Object.entries(schemaJson.fields)
    .find(([name]) => name.split(".").at(1) === tableName)
    ?.at(1) ?? []) as unknown as Field[];

  for (const field of fields) {
    const isPk =
      schemaJson.tableConstraints[tableIndex]?.[field.name]?.pk ?? false;
    const isUnique =
      schemaJson.tableConstraints[tableIndex]?.[field.name]?.unique ?? false;

    const isFk =
      schemaJson.refs.some((ref) =>
        ref.endpoints.some(
          (ep) =>
            ep.tableName === tableName &&
            ep.fieldNames.includes(field.name) &&
            ep.relation !== "1",
        ),
      ) ?? false;

    let fieldType: string = field.type.type_name.replace(/^public\./, "");

    if (fieldType === "text" && (isPk || isFk)) {
      fieldType = "uuid(7)";
    }

    const line = [
      fieldType,
      field.name,
      [isPk ? "PK" : null, isFk ? "FK" : null, isUnique ? "UK" : null]
        .filter(Boolean)
        .join(","),
      // field.note ? `"${field.note.replace(/"/g, '\\"')}"` : null
    ];

    writer.write(`  ${line.filter(Boolean).join(" ")}\n`);
  }

  writer.write("}\n\n");
  writer.flush();
}

for (const ref of schemaJson.refs) {
  const left = ref.endpoints.at(0);
  const right = ref.endpoints.at(1);

  if (!left || !right) {
    continue;
  }

  const leftRel =
    match(left.relation)
      .with("*", () => "}")
      .with("1", () => "|")
      .otherwise(() => "|") + (ref.onDelete === "CASCADE" ? "|" : "o");

  const rightRel = match(right.relation)
    .with("*", () => "o{")
    .with("1", () => "||")
    .otherwise(() => "||");

  const label = [
    [left.tableName, left.fieldNames.join(",")].join("."),
    "->",
    [right.tableName, right.fieldNames.join(",")].join("."),
  ].join(" ");

  const line = [
    left.tableName,

    [leftRel, "--", rightRel].join(""),

    right.tableName,
    `: "${label}"`,
  ];

  writer.write(`${line.filter(Boolean).join(" ")}\n`);
}

writer.write("```");
writer.end();
