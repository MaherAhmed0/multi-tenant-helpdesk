import type { Kysely, Transaction } from "kysely";
import { sql } from "kysely";

import type { Database } from "../database/types.js";

type DatabaseExecutor = Kysely<Database> | Transaction<Database>;

const customerTicketFields = [
  "id",
  "subject",
  "status",
  "created_at as createdAt",
  "updated_at as updatedAt",
] as const;

export async function createTicket(
  executor: DatabaseExecutor,
  input: { organizationId: string; customerId: string; subject: string },
) {
  return executor
    .insertInto("tickets")
    .values({
      organization_id: input.organizationId,
      customer_id: input.customerId,
      subject: input.subject,
    })
    .returning(customerTicketFields)
    .executeTakeFirstOrThrow();
}

function customerTicketQuery(
  executor: DatabaseExecutor,
  organizationId: string,
  customerId: string,
) {
  return executor
    .selectFrom("tickets")
    .where("organization_id", "=", organizationId)
    .where("customer_id", "=", customerId)
    .where("voided_at", "is", null)
    .select(customerTicketFields);
}

export async function listCustomerTickets(
  executor: DatabaseExecutor,
  organizationId: string,
  customerId: string,
  pagination: { page: number; limit: number },
) {
  const query = customerTicketQuery(executor, organizationId, customerId);
  const count = await query
    .clearSelect()
    .select((eb) => eb.fn.countAll<string>().as("total"))
    .executeTakeFirstOrThrow();
  const tickets = await query
    .orderBy("created_at", "desc")
    .orderBy("id", "desc")
    .limit(pagination.limit)
    .offset((pagination.page - 1) * pagination.limit)
    .execute();
  return { tickets, total: Number(count.total) };
}

export async function findCustomerTicketById(
  executor: DatabaseExecutor,
  organizationId: string,
  customerId: string,
  ticketId: string,
) {
  return customerTicketQuery(executor, organizationId, customerId)
    .where("id", "=", ticketId)
    .executeTakeFirst();
}

export async function findCustomerTicketForUpdate(
  executor: DatabaseExecutor,
  organizationId: string,
  customerId: string,
  ticketId: string,
) {
  return customerTicketQuery(executor, organizationId, customerId)
    .where("id", "=", ticketId)
    .forUpdate()
    .executeTakeFirst();
}

export async function reopenResolvedTicket(
  executor: DatabaseExecutor,
  organizationId: string,
  customerId: string,
  ticketId: string,
) {
  return executor
    .updateTable("tickets")
    .set({
      status: "OPEN",
      closed_at: null,
      updated_at: sql<Date>`greatest(updated_at, clock_timestamp())`,
    })
    .where("organization_id", "=", organizationId)
    .where("customer_id", "=", customerId)
    .where("id", "=", ticketId)
    .where("voided_at", "is", null)
    .where("status", "=", "RESOLVED")
    .returning(customerTicketFields)
    .executeTakeFirstOrThrow();
}

export async function touchTicket(
  executor: DatabaseExecutor,
  organizationId: string,
  customerId: string,
  ticketId: string,
) {
  return executor
    .updateTable("tickets")
    .set({ updated_at: sql<Date>`greatest(updated_at, clock_timestamp())` })
    .where("organization_id", "=", organizationId)
    .where("customer_id", "=", customerId)
    .where("id", "=", ticketId)
    .where("voided_at", "is", null)
    .where("status", "in", ["OPEN", "IN_PROGRESS"])
    .returning(customerTicketFields)
    .executeTakeFirstOrThrow();
}
