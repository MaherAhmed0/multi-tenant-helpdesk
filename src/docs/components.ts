// Documentation-only schemas. Application validation remains in feature modules.
export type Schema = Record<string, unknown>;
export const ref = (name: string): Schema => ({ $ref: `#/components/schemas/${name}` });
export const object = (properties: Record<string, Schema>, required = Object.keys(properties)): Schema => ({
  type: "object", properties, required, additionalProperties: false,
});
export const array = (items: Schema): Schema => ({ type: "array", items });
export const nullable = (schema: Schema): Schema => ({ anyOf: [schema, { type: "null" }] });
export const string: Schema = { type: "string" };
export const uuid: Schema = { type: "string", format: "uuid" };
export const datetime: Schema = { type: "string", format: "date-time" };
export const date: Schema = { type: "string", format: "date" };
export const count: Schema = { type: "integer", minimum: 0 };
export const boolean: Schema = { type: "boolean" };
export const enumeration = (...values: string[]): Schema => ({ type: "string", enum: values });
export const name: Schema = { type: "string", minLength: 1, maxLength: 255, description: "Trimmed; must not be blank." };
export const email: Schema = { type: "string", format: "email", maxLength: 254, description: "Trimmed and lowercased before use." };
export const slug: Schema = {
  type: "string", minLength: 1, maxLength: 100, pattern: "^[a-z0-9]+(-[a-z0-9]+)*$",
  description: "Trimmed and lowercased before validation.",
};
export const password: Schema = { type: "string", format: "password", minLength: 15, maxLength: 128, writeOnly: true, description: "Not trimmed. Supply your own password; documentation placeholders are not credentials." };
export const loginPassword: Schema = { ...password, minLength: 1 };
export const message: Schema = { type: "string", minLength: 1, maxLength: 10000, description: "Plain text, trimmed; must not be blank." };
export const role = enumeration("ORGANIZATION_ADMIN", "AGENT", "CUSTOMER");
export const status = enumeration("OPEN", "IN_PROGRESS", "RESOLVED", "CLOSED");
export const priority = enumeration("LOW", "NORMAL", "HIGH", "URGENT");
const teamSummary = object({ id: uuid, name: string, isGeneral: boolean, deactivatedAt: nullable(datetime) });
const user = { id: uuid, name: string, email: { type: "string", format: "email" }, role };
const lifecycleUser = { id: uuid, name: string, email: { type: "string", format: "email" }, deactivatedAt: nullable(datetime), createdAt: datetime };
const ticket = { id: uuid, subject: string, status, createdAt: datetime, updatedAt: datetime };
const staffTicket = {
  ...ticket, priority, closedAt: nullable(datetime), customer: object({ name: string }),
  assignedTeam: nullable(object({ id: uuid, name: string })),
  assignedAgent: nullable(object({ id: uuid, name: string })),
};
const invitation = {
  id: uuid, name: string, email: { type: "string", format: "email" },
  state: enumeration("pending", "expired", "revoked", "consumed"),
  createdAt: datetime, expiresAt: datetime, revokedAt: nullable(datetime), consumedAt: nullable(datetime),
};
const stateCounts = { total: count, active: count, deactivated: count };
const activityCounts = object({ created: count, closed: count });
const seconds = nullable({ type: "number", minimum: 0 });
export const paginated = (key: string, item: Schema): Schema => object({ [key]: array(item), pagination: ref("Pagination") });

export const schemas: Record<string, Schema> = {
  ApiError: object({
    error: string,
    details: { description: "Optional application details; validation failures commonly contain a Zod issue array. Omitted when undefined." },
  }, ["error"]),
  Pagination: object({ page: { type: "integer", minimum: 1 }, limit: { type: "integer", minimum: 1, maximum: 100 }, total: count, totalPages: count }),
  RegistrationInput: object({ organizationName: name, organizationSlug: slug, adminName: name, adminEmail: email, adminPassword: password }),
  RegistrationResult: object({ organization: object({ id: uuid, name: string, slug: string }), admin: object({ ...user, role: enumeration("ORGANIZATION_ADMIN") }) }),
  LoginInput: object({ organizationSlug: slug, email, password: loginPassword }),
  CustomerLoginInput: object({ email, password: loginPassword }),
  LoginResult: object({ user: object({ ...user, organizationId: uuid }), session: object({ id: uuid, absoluteExpiresAt: datetime }) }),
  TenantMe: object({ user: object({ id: uuid, organizationId: uuid, role }), session: object({ id: uuid }) }),
  CsrfToken: object({ csrfToken: { type: "string", description: "Session-bound CSRF token returned by this endpoint; send it in X-CSRF-Token. Not a session credential." } }),
  Session: object({ id: uuid, createdAt: datetime, lastActivityAt: datetime, absoluteExpiresAt: datetime, userAgent: nullable(string), isCurrent: boolean }),
  Sessions: object({ sessions: array(ref("Session")) }),
  SystemAdminLoginInput: object({ email, password: loginPassword }),
  MfaRequired: object({ mfaRequired: { type: "boolean", const: true } }),
  MfaInput: object({ code: { type: "string", pattern: "^[0-9]{6}$", minLength: 6, maxLength: 6, writeOnly: true, description: "Current six-digit authenticator code; retain leading zeroes. No trimming." } }),
  RecoveryInput: object({ code: { type: "string", pattern: "^[A-Za-z0-9_-]{22}$", minLength: 22, maxLength: 22, writeOnly: true, description: "One unused recovery code issued during provisioning. Case-sensitive; surrounding whitespace is trimmed." } }),
  Authenticated: object({ authenticated: { type: "boolean", const: true } }),
  SystemAdminMe: object({ id: uuid, email: { type: "string", format: "email" } }),
  PublicOrganization: object({ name: string, slug: string }),
  CustomerRegistrationInput: object({ name, email, password }),
  Customer: object({ ...user, role: enumeration("CUSTOMER") }),
  Organization: object({ id: uuid, name: string, slug: string, deactivatedAt: nullable(datetime), createdAt: datetime, updatedAt: datetime }),
  OrganizationAdmin: object(lifecycleUser),
  PlatformOverview: object({ organizations: object(stateCounts), tenantUsers: object({ ...stateCounts, byRole: object({ ORGANIZATION_ADMIN: count, AGENT: count, CUSTOMER: count }) }) }),
  Team: object({ id: uuid, name: string, isGeneral: boolean, deactivatedAt: nullable(datetime), createdAt: datetime }),
  TeamInput: object({ name }),
  Agent: object({ ...lifecycleUser, team: teamSummary }),
  AgentTeamInput: object({ teamId: uuid }),
  AgentInvitationInput: object({ name, email, teamId: uuid }, ["name", "email"]),
  AdminInvitationInput: object({ name, email }),
  AgentInvitation: object({ ...invitation, targetTeam: nullable(teamSummary) }),
  AdminInvitation: object(invitation),
  AgentInvitationCreated: object({ invitation: ref("AgentInvitation"), token: { type: "string", pattern: "^[A-Za-z0-9_-]{43}$", description: "Raw one-time invitation credential, returned only on creation. Deliver securely to the invitee; never log it." } }),
  AdminInvitationCreated: object({ invitation: ref("AdminInvitation"), token: { type: "string", pattern: "^[A-Za-z0-9_-]{43}$", description: "Raw one-time invitation credential, returned only on creation. Deliver securely to the invitee; never log it." } }),
  AcceptInvitationInput: object({ token: { type: "string", pattern: "^[A-Za-z0-9_-]{43}$", writeOnly: true, description: "Invitation credential received from the inviting administrator; not trimmed." }, password }),
  AcceptedInvitation: { oneOf: [
    object({ ...user, role: enumeration("AGENT"), team: ref("Team") }),
    object({ ...user, role: enumeration("ORGANIZATION_ADMIN"), team: { type: "null" } }),
  ] },
  CreateTicketInput: object({ subject: name, message }),
  TicketMessageInput: object({ message }),
  PublicMessage: object({ id: uuid, body: string, author: object({ name: string, type: enumeration("CUSTOMER", "STAFF") }), createdAt: datetime }),
  CustomerTicket: object(ticket),
  CustomerTicketDetail: object({ ...ticket, messages: array(ref("PublicMessage")) }),
  StaffTicket: object(staffTicket),
  StaffTicketDetail: object({ ...staffTicket, customer: object({ name: string, email: { type: "string", format: "email" } }), messages: array(ref("PublicMessage")) }),
  TicketList: { oneOf: [paginated("tickets", ref("CustomerTicket")), paginated("tickets", ref("StaffTicket"))] },
  TicketDetail: { oneOf: [ref("CustomerTicketDetail"), ref("StaffTicketDetail")] },
  MessageCreated: object({ message: ref("PublicMessage"), ticketStatus: status }),
  TicketAssignmentInput: object({ teamId: nullable(uuid), agentId: nullable(uuid) }),
  TicketStatusInput: object({ status }),
  TicketPriorityInput: object({ priority }),
  EmptyInput: object({}),
  TicketVoidInput: object({ reason: enumeration("INVALID", "SPAM", "DUPLICATE") }),
  TicketWithdrawn: object({ id: uuid, withdrawn: { type: "boolean", const: true } }),
  TicketVoided: object({ id: uuid, voided: { type: "boolean", const: true }, reason: enumeration("INVALID", "SPAM", "DUPLICATE") }),
  InternalNoteInput: object({ body: message }),
  InternalNote: object({ id: uuid, body: string, author: object({ id: uuid, name: string }), createdAt: datetime, updatedAt: datetime }),
  StatisticsOverview: object({
    generatedAt: datetime,
    tickets: object({ active: count, unassigned: count, urgent: count, oldestActiveTicketAgeSeconds: seconds,
      byStatus: object({ OPEN: count, IN_PROGRESS: count, RESOLVED: count, CLOSED: count }),
      byPriority: object({ LOW: count, NORMAL: count, HIGH: count, URGENT: count }),
    }),
    today: activityCounts, resolution: object({ averageCloseTimeSeconds: seconds }),
  }),
  StatisticsWorkload: object({
    generatedAt: datetime,
    assignment: object({ fullyUnassigned: count, teamOnly: count, agentOnly: count, teamAndAgent: count }),
    teams: array(object({ teamId: uuid, teamName: string, activeTickets: count, teamOnlyTickets: count, teamAndAgentTickets: count })),
    agents: array(object({ agentId: uuid, agentName: string, activeAssignedTickets: count })),
  }),
  StatisticsActivity: object({
    generatedAt: datetime, days: { type: "integer", minimum: 7, maximum: 90 }, from: date, to: date,
    totals: activityCounts,
    points: { ...array(object({ date, created: count, closed: count })), minItems: 7, maxItems: 90,
      description: "Exactly days chronological, consecutive UTC dates, inclusive of from and to; zero days are retained. Totals sum these points." },
  }),
};
