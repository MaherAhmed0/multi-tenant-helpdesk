import { sql, type Kysely, type Transaction } from "kysely";

import type { Database } from "../database/types.js";

type DatabaseExecutor = Kysely<Database> | Transaction<Database>;

function noteQuery(
  executor: DatabaseExecutor,
  organizationId: string,
  ticketId: string,
) {
  return executor
    .selectFrom("ticket_internal_notes as note")
    .innerJoin("users as author", (join) =>
      join
        .onRef("author.organization_id", "=", "note.organization_id")
        .onRef("author.id", "=", "note.author_user_id"),
    )
    .where("note.organization_id", "=", organizationId)
    .where("note.ticket_id", "=", ticketId)
    .select([
      "note.id",
      "note.body",
      "note.created_at as createdAt",
      "note.updated_at as updatedAt",
      "author.id as authorId",
      "author.name as authorName",
    ]);
}

export async function listTicketNotes(
  executor: DatabaseExecutor,
  organizationId: string,
  ticketId: string,
) {
  return noteQuery(executor, organizationId, ticketId)
    .orderBy("note.created_at", "asc")
    .orderBy("note.id", "asc")
    .execute();
}

export async function createTicketNote(
  executor: DatabaseExecutor,
  data: {
    organizationId: string;
    ticketId: string;
    authorId: string;
    body: string;
  },
) {
  const note = await executor
    .insertInto("ticket_internal_notes")
    .values({
      organization_id: data.organizationId,
      ticket_id: data.ticketId,
      author_user_id: data.authorId,
      body: data.body,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return noteQuery(executor, data.organizationId, data.ticketId)
    .where("note.id", "=", note.id)
    .executeTakeFirstOrThrow();
}

export async function updateOwnTicketNote(
  executor: DatabaseExecutor,
  data: {
    organizationId: string;
    ticketId: string;
    noteId: string;
    authorId: string;
    body: string;
  },
) {
  const note = await executor
    .updateTable("ticket_internal_notes")
    .set({
      body: data.body,
      updated_at: sql<Date>`greatest(updated_at, clock_timestamp())`,
    })
    .where("organization_id", "=", data.organizationId)
    .where("ticket_id", "=", data.ticketId)
    .where("id", "=", data.noteId)
    .where("author_user_id", "=", data.authorId)
    .returning("id")
    .executeTakeFirst();
  if (!note) return undefined;
  return noteQuery(executor, data.organizationId, data.ticketId)
    .where("note.id", "=", note.id)
    .executeTakeFirstOrThrow();
}

function noteTicketQuery(
  executor: DatabaseExecutor,
  organizationId: string,
  ticketId: string,
) {
  return executor
    .selectFrom("tickets")
    .select("id")
    .where("organization_id", "=", organizationId)
    .where("id", "=", ticketId)
    .where("voided_at", "is", null);
}

export async function findOrganizationTicketForNoteShare(
  executor: DatabaseExecutor,
  organizationId: string,
  ticketId: string,
) {
  return noteTicketQuery(executor, organizationId, ticketId)
    .forShare()
    .executeTakeFirst();
}

export async function findAgentTicketForNoteCreationShare(
  executor: DatabaseExecutor,
  organizationId: string,
  ticketId: string,
  agentId: string,
  teamId: string | null,
) {
  // The caller holds the agent row FOR SHARE, keeping current membership stable.
  return noteTicketQuery(executor, organizationId, ticketId)
    .where((eb) =>
      eb.or([
        eb("assigned_agent_id", "=", agentId),
        eb.and([
          eb("assigned_agent_id", "is", null),
          eb("assigned_team_id", "=", teamId),
        ]),
      ]),
    )
    .forShare()
    .executeTakeFirst();
}
