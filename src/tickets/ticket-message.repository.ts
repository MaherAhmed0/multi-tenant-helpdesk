import type { Kysely, Transaction } from "kysely";

import type { Database } from "../database/types.js";

type DatabaseExecutor = Kysely<Database> | Transaction<Database>;

function ticketMessageQuery(
  executor: DatabaseExecutor,
  organizationId: string,
  ticketId: string,
) {
  return executor.selectFrom("ticket_messages")
    .innerJoin("users", (join) => join
      .onRef("users.organization_id", "=", "ticket_messages.organization_id")
      .onRef("users.id", "=", "ticket_messages.author_user_id"))
    .where("ticket_messages.organization_id", "=", organizationId)
    .where("ticket_messages.ticket_id", "=", ticketId)
    .select([
      "ticket_messages.id", "ticket_messages.body", "ticket_messages.created_at as createdAt",
      "users.name as authorName", "users.role as authorRole",
    ]);
}

export async function createTicketMessage(
  executor: DatabaseExecutor,
  input: {
    organizationId: string;
    ticketId: string;
    authorUserId: string;
    body: string;
  },
) {
  const message = await executor
    .insertInto("ticket_messages")
    .values({
      organization_id: input.organizationId,
      ticket_id: input.ticketId,
      author_user_id: input.authorUserId,
      body: input.body,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return ticketMessageQuery(executor, input.organizationId, input.ticketId)
    .where("ticket_messages.id", "=", message.id).executeTakeFirstOrThrow();
}

// The service must authorize the ticket before reading its public conversation.
export async function listTicketMessages(
  executor: DatabaseExecutor,
  organizationId: string,
  ticketId: string,
) {
  return ticketMessageQuery(executor, organizationId, ticketId)
    .orderBy("ticket_messages.created_at", "asc")
    .orderBy("ticket_messages.id", "asc")
    .execute();
}
