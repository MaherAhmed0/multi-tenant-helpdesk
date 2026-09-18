import {
  schemas, ref, object, array, paginated, string, uuid, slug, enumeration,
  type Schema,
} from "./components.js";

// These helpers only assemble the static document; they never inspect or change application code.
type Access = "public" | "tenant" | "systemAdmin" | "challenge";
type OperationOptions = {
  access?: Access;
  csrf?: boolean;
  parameters?: Record<string, unknown>[];
  body?: string;
  optionalBody?: boolean;
  example?: unknown;
  result?: Schema;
  responseExample?: unknown;
  status?: number;
  errors?: Record<number, string>;
  noStore?: boolean;
  cookie?: string;
  cache?: boolean;
  contentType?: string;
};
const requestIdHeader = { description: "Server-generated request correlation ID.", schema: uuid };
const noStoreHeader = { description: "Do not store this response.", schema: { type: "string", const: "no-store" } };
const parameter = (name: string, schema: Schema, description: string, location = "query", required = false) =>
  ({ name, in: location, required, schema, description });
const pagination = [
  parameter("page", { type: "integer", minimum: 1, maximum: 1000000, default: 1 }, "Positive decimal digits only; no leading zeroes."),
  parameter("limit", { type: "integer", minimum: 1, maximum: 100, default: 20 }, "Positive decimal digits only; no leading zeroes."),
];
const stateFilter = parameter("status", enumeration("active", "deactivated"), "Omit to include both states.");
const search = parameter("search", { type: "string", minLength: 1, maxLength: 255 }, "Trimmed, case-insensitive literal substring; wildcard characters are treated literally.");
const clientHeader = parameter("X-Helpdesk-Client", { type: "string", const: "web" }, "Required before credential authentication; missing or incorrect value returns 403.", "header", true);
const slugParameter = parameter("slug", slug, "Public organization slug. This selects the onboarding organization only, never authenticated tenant identity.", "path", true);
const errors = {
  400: "Invalid request parameters or JSON body.",
  401: "Authentication required. Invalid, expired, revoked or deactivated sessions are indistinguishable.",
  403: "Request forbidden for this role, or missing/invalid CSRF token where required.",
  404: "Resource not found or inaccessible; foreign tenant resources are concealed.",
  409: "The requested operation conflicts with the current resource state.",
  410: "Invitation has expired, has been revoked, or is no longer available.",
  429: "Too many login attempts.",
  500: "Unexpected failure; response is generic and contains no internal details.",
};
const paths: Record<string, Record<string, unknown>> = {};
function endpoint(method: string, path: string, tag: string, summary: string, description: string, options: OperationOptions = {}) {
  const access = options.access ?? "tenant";
  const security = access === "public" ? [] : [
    access === "tenant"
      ? { tenantSession: [], ...(options.csrf ? { csrfToken: [] } : {}) }
      : access === "systemAdmin" ? { systemAdminSession: [] } : { mfaChallenge: [] },
  ];
  const authDescription = access === "tenant"
    ? "Tenant organization and actor identity come exclusively from the authenticated session. "
    : access === "systemAdmin"
      ? "SYSTEM_ADMIN only, using its separate authenticated session cookie. Tenant credentials do not authorize this operation. No SYSTEM_ADMIN CSRF header is currently enforced. "
      : access === "challenge" ? "Requires the password-step MFA challenge cookie; this is not a fully authenticated session. " : "";
  const parameters = [...(options.parameters ?? [])];
  for (const match of path.matchAll(/\{([^}]+)\}/g)) {
    const name = match[1]!;
    if (!parameters.some((p) => p.in === "path" && p.name === name)) {
      const nonEnumeratingSession = path.includes("/sessions/");
      parameters.push(parameter(name, nonEnumeratingSession ? string : uuid,
        nonEnumeratingSession ? "Session UUID. Malformed, missing, foreign or already-revoked target IDs all return 204 after authentication." : "Resource UUID.", "path", true));
    }
  }
  const headers: Record<string, unknown> = { "X-Request-Id": requestIdHeader };
  if (options.noStore) headers["Cache-Control"] = noStoreHeader;
  if (options.cache) headers["X-Cache"] = { description: "HIT: cached snapshot; MISS: fresh snapshot; BYPASS: cache unavailable or unusable. Cache hits retain generatedAt.", schema: enumeration("HIT", "MISS", "BYPASS") };
  if (options.cookie) headers["Set-Cookie"] = { description: options.cookie, schema: string };
  const status = options.status ?? 200;
  const responses: Record<string, unknown> = {
    [status]: {
      description: status === 204 ? "Success; no response body." : "Success.",
      headers,
      ...(status === 204 ? {} : { content: { [options.contentType ?? "application/json"]: {
        schema: options.result ?? ref("ApiError"),
        ...(options.responseExample === undefined ? {} : { example: options.responseExample }),
      } } }),
    },
  };
  const failures: Record<number, string> = { 500: errors[500], ...(access === "public" ? {} : { 401: errors[401] }), ...(options.csrf ? { 403: errors[403] } : {}), ...options.errors };
  for (const [code, description] of Object.entries(failures)) {
    responses[code] = {
      description, headers: { "X-Request-Id": requestIdHeader },
      content: { "application/json": { schema: ref("ApiError"),
        ...(code === "500" ? { example: { error: "Internal server error" } } : {}),
      } },
    };
  }
  paths[path] ??= {};
  paths[path][method] = {
    operationId: method + path.replace(/[{}]/g, "").split("/").filter(Boolean).map((part) => part.replace(/(^|-)([a-z])/g, (_m, _dash, letter: string) => letter.toUpperCase())).join(""),
    tags: [tag], summary, description: authDescription + description, security,
    ...(parameters.length ? { parameters } : {}),
    ...(options.body ? { requestBody: {
      required: !options.optionalBody,
      content: { "application/json": { schema: ref(options.body), ...(options.example === undefined ? {} : { example: options.example }) } },
    } } : {}),
    responses,
  };
}
const invalid = { 400: errors[400] };
const scopedRead = { ...invalid, 403: errors[403], 404: errors[404] };
const scopedWrite = { ...scopedRead, 409: errors[409] };
const tenantCookie = "Sets session: HttpOnly; SameSite=Strict; Path=/; Secure when configured. Browser-session cookie; server expiry remains authoritative.";
const clearTenantCookie = "Clears session using matching Path=/ and cookie options.";
const adminCookie = "Clears system_admin_mfa_challenge (Path=/system-admin/auth) and sets system_admin_session (HttpOnly; SameSite=Strict; Path=/system-admin; Secure when configured). Browser-session cookie.";
const clearAdminCookie = "Clears system_admin_session using matching Path=/system-admin and cookie options.";
const sampleId = "00000000-0000-4000-8000-000000000001";
const sampleDate = "2026-09-18T12:00:00.000Z";

endpoint("get", "/health", "Operations", "Application liveness", "Returns a static liveness response; does not check database or Redis readiness.", { access: "public", result: object({ status: { type: "string", const: "ok" } }), responseExample: { status: "ok" } });
endpoint("get", "/metrics", "Operations", "Prometheus metrics", "Operational endpoint currently has no application authentication. Exposes HTTP request counters and duration histogram.", { access: "public", result: string, contentType: "text/plain; version=0.0.4; charset=utf-8" });
endpoint("post", "/organization-registration", "Organization Registration", "Register an organization and its administrator",
  "Creates the organization, General team and initial ORGANIZATION_ADMIN atomically. Does not log the administrator in. Organization slug must be globally unique.",
  { access: "public", body: "RegistrationInput", status: 201, result: ref("RegistrationResult"), errors: { ...invalid, 409: "Organization slug already exists." },
    example: { organizationName: "Example Support", organizationSlug: "example-support", adminName: "Example Administrator", adminEmail: "admin@example.com", adminPassword: "<choose-your-own-password>" },
    responseExample: { organization: { id: sampleId, name: "Example Support", slug: "example-support" }, admin: { id: "00000000-0000-4000-8000-000000000002", name: "Example Administrator", email: "admin@example.com", role: "ORGANIZATION_ADMIN" } },
  });
endpoint("post", "/auth/login", "Authentication", "Tenant login",
  "Authenticates any tenant role. Generic credential failures do not disclose account existence or deactivation. Five failures in a 15-minute window start a one-minute block; the threshold attempt and blocked requests return 429. A successful login clears prior failures. Cookie sessions have a 30-minute idle timeout and seven-day absolute lifetime.",
  { access: "public", parameters: [clientHeader], body: "LoginInput", result: ref("LoginResult"), cookie: tenantCookie,
    errors: { ...invalid, 401: "Invalid credentials.", 403: "Missing or incorrect X-Helpdesk-Client: web.", 429: errors[429] },
    example: { organizationSlug: "example-support", email: "customer@example.com", password: "<your-password>" },
    responseExample: { user: { id: sampleId, organizationId: "00000000-0000-4000-8000-000000000002", name: "Example Customer", email: "customer@example.com", role: "CUSTOMER" }, session: { id: "00000000-0000-4000-8000-000000000003", absoluteExpiresAt: "2026-09-25T12:00:00.000Z" } },
  });
endpoint("get", "/auth/me", "Authentication", "Current tenant principal", "Any authenticated tenant role. Successful authentication counts as session activity.", { result: ref("TenantMe") });
endpoint("get", "/auth/csrf", "Authentication", "Get a session-bound CSRF token", "Any authenticated tenant role. Call after login and send the returned csrfToken as X-CSRF-Token on protected tenant mutations. A token from another session does not authorize this session.", { result: ref("CsrfToken"), noStore: true });
endpoint("post", "/auth/logout", "Sessions", "Log out current tenant session", "Any authenticated tenant role. Revokes the current session and clears its cookie. Subsequent requests with that session fail authentication.", { csrf: true, status: 204, cookie: clearTenantCookie });
endpoint("get", "/auth/sessions", "Sessions", "List own usable tenant sessions", "Any authenticated tenant role. Lists only this user and organization's unrevoked, idle-valid, absolute-valid sessions. isCurrent identifies the requesting session.", { result: ref("Sessions"), responseExample: { sessions: [{ id: sampleId, createdAt: sampleDate, lastActivityAt: sampleDate, absoluteExpiresAt: "2026-09-25T12:00:00.000Z", userAgent: "Example browser", isCurrent: true }] } });
endpoint("delete", "/auth/sessions/{sessionId}", "Sessions", "Revoke one owned tenant session", "Any authenticated tenant role. Non-enumerating and idempotent for malformed, unknown, foreign and already-revoked targets. Only the current user and organization's sessions can be revoked. Targeting the current session also clears its cookie.", { csrf: true, status: 204, cookie: "Clears session only when the target equals the authenticated session ID." });
endpoint("post", "/auth/logout-all", "Sessions", "Log out all own tenant sessions", "Any authenticated tenant role. Revokes all this account's unrevoked sessions, including the current session; does not affect another organization or user.", { csrf: true, status: 204, cookie: clearTenantCookie });

endpoint("get", "/public/organizations/{slug}", "Customer Onboarding", "Discover a support organization", "Only active organizations are publicly discoverable; absent and deactivated organizations return 404.", { access: "public", parameters: [slugParameter], result: ref("PublicOrganization"), errors: { ...invalid, 404: "Support organization not found." }, noStore: true, responseExample: { name: "Example Support", slug: "example-support" } });
endpoint("post", "/public/organizations/{slug}/customers/register", "Customer Onboarding", "Register a customer", "Creates a CUSTOMER in the active organization selected by the public slug. The email must not already belong to a user in that organization; use in another organization is allowed. Does not create a session.", { access: "public", parameters: [slugParameter], body: "CustomerRegistrationInput", status: 201, result: ref("Customer"), noStore: true, errors: { ...invalid, 404: "Support organization not found.", 409: "An account with this email already exists." }, example: { name: "Example Customer", email: "customer@example.com", password: "<choose-your-own-password>" } });
endpoint("post", "/public/organizations/{slug}/customers/login", "Customer Onboarding", "Customer-only login by organization slug", "Same cookie and throttle policy as /auth/login, sharing the slug/email throttle identity. Only CUSTOMER accounts succeed; other roles receive generic credential failure. Unknown/inactive organizations also produce generic credential failure, not public discovery 404.", { access: "public", parameters: [slugParameter, clientHeader], body: "CustomerLoginInput", result: ref("LoginResult"), noStore: true, cookie: tenantCookie, errors: { ...invalid, 401: "Invalid credentials.", 403: "Missing or incorrect X-Helpdesk-Client: web.", 429: errors[429] } });

endpoint("get", "/teams", "Teams", "List teams", "ORGANIZATION_ADMIN only. Includes General; ordered General first, then normalized name and ID. No pagination. Unknown query keys are rejected.", { parameters: [stateFilter], result: object({ teams: array(ref("Team")) }), noStore: true, errors: { ...invalid, 403: errors[403] } });
endpoint("get", "/teams/{teamId}", "Teams", "Get a team", "ORGANIZATION_ADMIN only. May read active or deactivated teams.", { result: ref("Team"), noStore: true, errors: scopedRead });
endpoint("post", "/teams", "Teams", "Create a team", "ORGANIZATION_ADMIN only. Creates an active non-General team. Trimmed, case-insensitive team names are unique in the organization.", { csrf: true, body: "TeamInput", result: ref("Team"), status: 201, errors: { ...invalid, 409: "Team name already exists." }, example: { name: "Technical" } });
endpoint("patch", "/teams/{teamId}", "Teams", "Rename a team", "ORGANIZATION_ADMIN only. General cannot be renamed. Deactivated non-General teams can be renamed.", { csrf: true, body: "TeamInput", result: ref("Team"), errors: scopedWrite });
endpoint("post", "/teams/{teamId}/deactivate", "Teams", "Deactivate a team", "ORGANIZATION_ADMIN only. General cannot be deactivated. Idempotent. Moves active member agents to General, leaves inactive agents' retained membership unchanged, and clears ticket team assignments while preserving valid individual assignments. These changes commit together.", { csrf: true, result: ref("Team"), errors: scopedWrite });
endpoint("post", "/teams/{teamId}/reactivate", "Teams", "Reactivate a team", "ORGANIZATION_ADMIN only. Idempotent; does not restore earlier memberships or ticket assignments.", { csrf: true, result: ref("Team"), errors: scopedRead });

endpoint("get", "/agents", "Agents", "List agents", "ORGANIZATION_ADMIN only. Includes only AGENT users in the authenticated organization. Search matches name or email. Ordered createdAt DESC, id DESC. Unknown query keys are rejected.", { parameters: [stateFilter, parameter("teamId", uuid, "Filter by current team."), search, ...pagination], result: paginated("agents", ref("Agent")), noStore: true, errors: { ...invalid, 403: errors[403] } });
endpoint("get", "/agents/{agentId}", "Agents", "Get an agent", "ORGANIZATION_ADMIN only. Non-AGENT users and foreign users are concealed as 404.", { result: ref("Agent"), noStore: true, errors: scopedRead });
endpoint("put", "/agents/{agentId}/team", "Agents", "Reassign an agent's team", "ORGANIZATION_ADMIN only. Target team must be active and in this organization; the agent may be inactive. Clears individual ticket assignments where a ticket team conflicts with the new membership, preserving ticket teams and agent-only assignments.", { csrf: true, body: "AgentTeamInput", result: ref("Agent"), errors: scopedWrite, example: { teamId: sampleId } });
endpoint("post", "/agents/{agentId}/deactivate", "Agents", "Deactivate and log out an agent", "ORGANIZATION_ADMIN only. Retains team membership, revokes sessions and clears individual ticket assignments atomically. Repeated calls succeed and revoke any remaining sessions.", { csrf: true, result: ref("Agent"), errors: scopedRead });
endpoint("post", "/agents/{agentId}/reactivate", "Agents", "Reactivate an agent", "ORGANIZATION_ADMIN only. Uses the retained team if active, otherwise General. Already-active agents remain unchanged. Does not restore sessions or assignments.", { csrf: true, result: ref("Agent"), errors: scopedRead });
endpoint("post", "/agents/{agentId}/revoke-sessions", "Agents", "Force agent logout", "ORGANIZATION_ADMIN only. Revokes the agent's sessions without changing account state, team membership or tickets. Zero sessions is success.", { csrf: true, status: 204, errors: scopedRead });

for (const [base, label, schema] of [
  ["/agent-invitations", "AGENT", "AgentInvitation"],
  ["/organization-admin-invitations", "ORGANIZATION_ADMIN", "AdminInvitation"],
] as const) {
  endpoint("get", base, "Invitations", `List ${label} invitations`,
    `ORGANIZATION_ADMIN only. Lists only ${label} invitations in this organization. State precedence: consumed, revoked, expired, pending. Ordered createdAt DESC, id DESC. Never returns credentials. Unknown query keys are rejected.`,
    { parameters: [parameter("status", enumeration("pending", "expired", "revoked", "consumed"), "Optional derived lifecycle state."), ...pagination], result: paginated("invitations", ref(schema)), noStore: true, errors: { ...invalid, 403: errors[403] } });
  endpoint("post", base, "Invitations", `Invite an ${label}`,
    `ORGANIZATION_ADMIN only. Role is server-selected. Same-organization existing users conflict. Only one open invitation per organization/email across BOTH invitation roles; unexpired duplicates conflict. An expired open invitation is revoked and replaced atomically with a new 24-hour credential. Raw token is returned only here; no email is sent. ${label === "AGENT" ? "Optional teamId must identify an active local team; omission stores no target team and acceptance selects General. Team activity is re-evaluated at acceptance." : "No teamId is accepted."}`,
    { csrf: true, body: schema + "Input", result: ref(schema + "Created"), status: 201, noStore: true, errors: label === "AGENT" ? scopedWrite : { ...invalid, 409: errors[409] }, example: { name: "Example Invitee", email: "invitee@example.com" } });
  endpoint("post", base + "/{invitationId}/revoke", "Invitations", `Revoke an ${label} invitation`,
    "ORGANIZATION_ADMIN only. Pending or expired open invitations can be revoked. Repeated revocation succeeds. Consumed invitations conflict; wrong-role or foreign invitations return 404. Does not modify users.",
    { csrf: true, result: ref(schema), noStore: true, errors: scopedWrite });
}
endpoint("post", "/invitations/accept", "Invitations", "Accept an invitation and choose a password", "Public credential-based operation for AGENT or ORGANIZATION_ADMIN invitations. Identity, role and organization come from the invitation. AGENT acceptance uses the target team when active, otherwise General; administrators have no team. Creates the user and consumes the invitation atomically. Does not automatically log in. Unknown token is 400, consumed is 409, revoked/expired is 410. Deactivated organization or existing local email conflicts.", { access: "public", body: "AcceptInvitationInput", result: ref("AcceptedInvitation"), status: 201, noStore: true, errors: { ...invalid, 409: errors[409], 410: errors[410] } });

const visibility = "CUSTOMER sees only their own non-voided tickets. ORGANIZATION_ADMIN sees all non-voided tickets in their organization. AGENT sees direct assignments, tickets assigned to their current team (including a teammate's assignment), and fully unassigned tickets. Inaccessible/voided tickets return 404.";
const staffAuthority = "ORGANIZATION_ADMIN may act on any non-voided ticket in the organization. An active AGENT needs direct individual assignment, or a team-only ticket assigned to their current team. Visibility alone is insufficient: fully unassigned tickets must be claimed first, and same-team tickets individually assigned to someone else cannot be mutated.";
endpoint("post", "/tickets", "Tickets", "Create a customer ticket", "CUSTOMER only. Subject and initial public message are created atomically. Server selects OPEN status, NORMAL priority and no assignments. No separate description field. Customers cannot submit or receive priority/assignment/internal-note fields.", { csrf: true, body: "CreateTicketInput", result: ref("CustomerTicketDetail"), status: 201, noStore: true, errors: invalid, example: { subject: "Example sign-in problem", message: "The example application does not open." }, responseExample: { id: sampleId, subject: "Example sign-in problem", status: "OPEN", createdAt: sampleDate, updatedAt: sampleDate, messages: [{ id: "00000000-0000-4000-8000-000000000002", body: "The example application does not open.", author: { name: "Example Customer", type: "CUSTOMER" }, createdAt: sampleDate }] } });
endpoint("get", "/tickets", "Tickets", "List visible tickets", visibility + " Paginated newest first: createdAt DESC, id DESC. CUSTOMER gets CustomerTicket; staff gets StaffTicket. No status/priority/void filter exists; unknown query keys are rejected.", { parameters: pagination, result: ref("TicketList"), noStore: true, errors: { ...invalid, 403: errors[403] } });
endpoint("get", "/tickets/{ticketId}", "Tickets", "Get a ticket and public conversation", visibility + " Messages are ordered createdAt ASC, id ASC with author name and CUSTOMER/STAFF classification. Staff detail includes customer email; customer detail never includes priority, assignment, closedAt or internal notes.", { result: ref("TicketDetail"), noStore: true, errors: scopedRead });
endpoint("post", "/tickets/{ticketId}/claim", "Tickets", "Claim a ticket as the current agent", "AGENT only. Requires a non-voided OPEN/IN_PROGRESS ticket with no individual assignee, and either no team or the agent's current team. Sets only the individual assignee and updatedAt; preserves team/status/priority. Inaccessible ticket is 404; visible but not claimable is 409.", { csrf: true, body: "EmptyInput", optionalBody: true, example: {}, result: ref("StaffTicket"), noStore: true, errors: scopedWrite });
endpoint("post", "/tickets/{ticketId}/release", "Tickets", "Release own individual assignment", "AGENT only. Requires a non-voided OPEN/IN_PROGRESS ticket individually assigned to this agent. Clears only the individual assignment, preserving team, status and priority. Inaccessible is 404; visible but not releasable is 409.", { csrf: true, body: "EmptyInput", optionalBody: true, example: {}, result: ref("StaffTicket"), noStore: true, errors: scopedWrite });
endpoint("put", "/tickets/{ticketId}/assignment", "Tickets", "Replace the complete assignment state", "ORGANIZATION_ADMIN only. OPEN/IN_PROGRESS and non-voided tickets only. Both nullable IDs are required: neither, team-only, agent-only, and team+agent are supported. Referenced team and AGENT must be active and in this organization. When both are supplied, the agent must belong to that team. Agent-only never infers a team. No automatic status/priority change.", { csrf: true, body: "TicketAssignmentInput", result: ref("StaffTicket"), noStore: true, errors: scopedWrite, example: { teamId: sampleId, agentId: null } });
endpoint("patch", "/tickets/{ticketId}/status", "Tickets", "Change ticket workflow status", staffAuthority + " Transitions: OPEN -> IN_PROGRESS/RESOLVED/CLOSED; IN_PROGRESS -> OPEN/RESOLVED/CLOSED; RESOLVED -> OPEN/CLOSED; CLOSED -> OPEN. Same status or any other transition returns 409. Concurrent source-status change may also conflict. Entering CLOSED sets closedAt; leaving it clears closedAt. Priority and assignment are preserved.", { csrf: true, body: "TicketStatusInput", result: ref("StaffTicket"), noStore: true, errors: scopedWrite, example: { status: "RESOLVED" } });
endpoint("patch", "/tickets/{ticketId}/priority", "Tickets", "Change ticket priority", staffAuthority + " OPEN, IN_PROGRESS or RESOLVED only. CLOSED and same-priority requests return 409. Only priority and updatedAt change; concurrent valid writes use last-valid-write-wins semantics.", { csrf: true, body: "TicketPriorityInput", result: ref("StaffTicket"), noStore: true, errors: scopedWrite, example: { priority: "HIGH" } });
endpoint("post", "/tickets/{ticketId}/messages", "Ticket Messages", "Add a public ticket reply", "CUSTOMER may reply only to their own non-voided ticket. A customer reply to RESOLVED reopens it to OPEN. Staff replies use the following authority: " + staffAuthority + " CLOSED tickets reject all replies with 409. Staff replies preserve workflow status, including RESOLVED. Reply and ticket update commit together. Everyone receives the same public message projection; internal notes are separate.", { csrf: true, body: "TicketMessageInput", result: ref("MessageCreated"), status: 201, noStore: true, errors: scopedWrite, example: { message: "Here is additional information about the example issue." }, responseExample: { message: { id: sampleId, body: "Here is additional information about the example issue.", author: { name: "Example Agent", type: "STAFF" }, createdAt: sampleDate }, ticketStatus: "IN_PROGRESS" } });
endpoint("get", "/tickets/{ticketId}/internal-notes", "Internal Notes", "Read internal notes", "AGENT or ORGANIZATION_ADMIN only; CUSTOMER gets 403. Uses ordinary staff ticket visibility, not mutation authority. CLOSED tickets are allowed; voided tickets are not. Notes are chronological (createdAt ASC, id ASC). Never included in customer/public conversation responses.", { result: object({ notes: array(ref("InternalNote")) }), noStore: true, errors: scopedRead });
endpoint("post", "/tickets/{ticketId}/internal-notes", "Internal Notes", "Add an internal note", staffAuthority + " CUSTOMER gets 403. Notes are allowed even on CLOSED tickets, but not voided tickets. Creating a note does not change ticket status, assignment, priority or ticket updatedAt.", { csrf: true, body: "InternalNoteInput", result: ref("InternalNote"), status: 201, noStore: true, errors: scopedWrite, example: { body: "Example staff-only investigation note." } });
endpoint("patch", "/tickets/{ticketId}/internal-notes/{noteId}", "Internal Notes", "Edit own internal note", "AGENT or ORGANIZATION_ADMIN only. Both roles may edit only notes they authored; administrators cannot edit another author's note. Ticket must remain visible under ordinary staff read rules and non-voided; CLOSED is allowed. Lost visibility or wrong author/note returns 404. Only the note body and note updatedAt change.", { csrf: true, body: "InternalNoteInput", result: ref("InternalNote"), noStore: true, errors: scopedRead, example: { body: "Updated example staff-only note." } });
endpoint("post", "/tickets/{ticketId}/withdraw", "Tickets", "Withdraw own customer ticket", "CUSTOMER only. Own non-voided OPEN/IN_PROGRESS/RESOLVED ticket only; CLOSED conflicts. Marks the ticket void with CUSTOMER_WITHDRAWN reason while preserving workflow status and assignments. It disappears from normal reads. Already-withdrawn/voided or inaccessible tickets return 404.", { csrf: true, body: "EmptyInput", optionalBody: true, result: ref("TicketWithdrawn"), noStore: true, errors: scopedWrite });
endpoint("post", "/tickets/{ticketId}/void", "Tickets", "Void an invalid, spam or duplicate ticket", staffAuthority + " Unlike priority or replies, staff voiding is permitted even on CLOSED tickets. Voiding is separate from workflow status; assignments/status/closedAt are preserved. Already-voided/inaccessible tickets return 404; visible tickets without AGENT mutation authority return 409.", { csrf: true, body: "TicketVoidInput", result: ref("TicketVoided"), noStore: true, errors: scopedWrite, example: { reason: "DUPLICATE" } });
endpoint("post", "/tickets/{ticketId}/restore", "Tickets", "Restore a voided or withdrawn ticket", "ORGANIZATION_ADMIN only. Target must be a voided ticket in this organization, otherwise 404 (including an already-restored ticket). Clears void metadata and updates updatedAt, preserving workflow status, closedAt and current assignments. Does not reconstruct previous assignments.", { csrf: true, body: "EmptyInput", optionalBody: true, result: ref("StaffTicket"), noStore: true, errors: scopedRead });

endpoint("post", "/system-admin/auth/login", "System Admin Authentication", "Start SYSTEM_ADMIN password login", "Successful password authentication creates only a five-minute MFA challenge, not a session. Continue using /mfa or /recovery. Generic credential errors conceal account existence and deactivation. Currently no X-Helpdesk-Client guard or login throttle is enforced on this route.", { access: "public", body: "SystemAdminLoginInput", result: ref("MfaRequired"), noStore: true, cookie: "Sets system_admin_mfa_challenge: HttpOnly; SameSite=Strict; Path=/system-admin/auth; Secure when configured; expires after five minutes.", errors: { ...invalid, 401: "Invalid credentials." }, example: { email: "platform-admin@example.com", password: "<your-password>" }, responseExample: { mfaRequired: true } });
endpoint("post", "/system-admin/auth/mfa", "System Admin Authentication", "Complete MFA with TOTP", "Active password-step challenge and active SYSTEM_ADMIN required. Six-digit SHA-1 TOTP, 30-second period with five-second epoch tolerance. A previously accepted time step cannot create another session. Invalid well-formed codes consume the shared five-attempt challenge budget; schema-invalid requests do not. Success atomically consumes the challenge and creates a fully authenticated session; 30-minute idle and eight-hour absolute expiry. All unusable challenge/code states use the same public failure.", { access: "challenge", body: "MfaInput", result: ref("Authenticated"), noStore: true, cookie: adminCookie, errors: { ...invalid, 401: "MFA authentication failed." }, responseExample: { authenticated: true } });
endpoint("post", "/system-admin/auth/recovery", "System Admin Authentication", "Complete MFA with a recovery code", "Alternative to TOTP after password login. Uses one unused, case-sensitive recovery code for the challenge's SYSTEM_ADMIN. Successful code consumption, challenge consumption and session creation are atomic; a code cannot be reused. Invalid codes share the five-attempt challenge budget with TOTP. Missing, expired, consumed or exhausted challenge, invalid code and deactivation all fail generically.", { access: "challenge", body: "RecoveryInput", result: ref("Authenticated"), noStore: true, cookie: adminCookie, errors: { ...invalid, 401: "MFA authentication failed." }, responseExample: { authenticated: true } });
endpoint("get", "/system-admin/auth/me", "System Admin Authentication", "Current SYSTEM_ADMIN principal", "Successful authentication updates session activity. Unusable presented session cookies are cleared; missing cookies do not require clearing.", { access: "systemAdmin", result: ref("SystemAdminMe"), noStore: true, responseExample: { id: sampleId, email: "platform-admin@example.com" } });
endpoint("post", "/system-admin/auth/logout", "System Admin Sessions", "Log out current SYSTEM_ADMIN session", "Revokes the current session; subsequent requests using it fail authentication.", { access: "systemAdmin", status: 204, cookie: clearAdminCookie });
endpoint("get", "/system-admin/auth/sessions", "System Admin Sessions", "List own usable SYSTEM_ADMIN sessions", "Only own unrevoked, idle-valid, absolute-valid sessions; isCurrent marks the current session. No credentials are returned.", { access: "systemAdmin", result: ref("Sessions"), noStore: true });
endpoint("delete", "/system-admin/auth/sessions/{id}", "System Admin Sessions", "Revoke an owned SYSTEM_ADMIN session", "Non-enumerating 204 for malformed, unknown, other-admin or already-revoked targets. Clears the current cookie only when the requested ID is the current session.", { access: "systemAdmin", status: 204, cookie: "Clears system_admin_session only when targeting the current session." });
endpoint("post", "/system-admin/auth/logout-all", "System Admin Sessions", "Log out all own SYSTEM_ADMIN sessions", "Revokes all own unrevoked sessions, including current; leaves other SYSTEM_ADMIN sessions unaffected.", { access: "systemAdmin", status: 204, cookie: clearAdminCookie });

endpoint("get", "/system-admin/organizations", "Platform Organizations", "List organizations across the platform", "Explicit platform-wide read. Search matches organization name or slug. Ordered createdAt DESC, id DESC. Unknown query keys are rejected.", { access: "systemAdmin", parameters: [search, stateFilter, ...pagination], result: paginated("organizations", ref("Organization")), noStore: true, errors: invalid });
endpoint("get", "/system-admin/organizations/{organizationId}", "Platform Organizations", "Get a platform organization", "Path ID is an administrative resource target, not tenant authentication context. Includes active/deactivated organization metadata only.", { access: "systemAdmin", result: ref("Organization"), noStore: true, errors: { ...invalid, 404: errors[404] }, responseExample: { id: sampleId, name: "Example Support", slug: "example-support", deactivatedAt: null, createdAt: sampleDate, updatedAt: sampleDate } });
endpoint("get", "/system-admin/organizations/{organizationId}/admins", "Platform Organizations", "List organization administrators", "Returns only ORGANIZATION_ADMIN tenant users in the target organization, including deactivated administrators. No pagination. Unknown organization is 404, not an empty list.", { access: "systemAdmin", result: object({ admins: array(ref("OrganizationAdmin")) }), noStore: true, errors: { ...invalid, 404: errors[404] } });
endpoint("post", "/system-admin/organizations/{organizationId}/deactivate", "Platform Organizations", "Deactivate an organization", "Atomically deactivates the organization and revokes its tenant sessions. Repeated calls succeed and revoke remaining sessions. User activation states remain unchanged.", { access: "systemAdmin", status: 204, errors: { ...invalid, 404: errors[404] } });
endpoint("post", "/system-admin/organizations/{organizationId}/reactivate", "Platform Organizations", "Reactivate an organization", "Idempotent. Does not reactivate individually deactivated users or restore old sessions.", { access: "systemAdmin", status: 204, errors: { ...invalid, 404: errors[404] } });
endpoint("post", "/system-admin/organizations/{organizationId}/revoke-sessions", "Platform Organizations", "Force organization-wide tenant logout", "Revokes tenant sessions for the target organization without changing organization or user activation states. Zero sessions is success.", { access: "systemAdmin", status: 204, errors: { ...invalid, 404: errors[404] } });
endpoint("post", "/system-admin/tenant-users/{userId}/deactivate", "Platform Tenant Users", "Deactivate a tenant user", "Targets a tenant user, never a SYSTEM_ADMIN. Deactivation and session revocation commit together. For AGENT users clears individual ticket assignments. Cannot deactivate the last active ORGANIZATION_ADMIN of an active organization (409); repeated deactivation otherwise succeeds.", { access: "systemAdmin", status: 204, errors: { ...invalid, 404: errors[404], 409: "Cannot deactivate the last active organization admin." } });
endpoint("post", "/system-admin/tenant-users/{userId}/reactivate", "Platform Tenant Users", "Reactivate a tenant user", "Organization must be active, otherwise 409 even for an already-active user. Does not restore old sessions or ticket assignments. AGENT reactivation retains an active team, or falls back to the organization General team if the retained team is deactivated, using the same lifecycle logic as /agents/{agentId}/reactivate.", { access: "systemAdmin", status: 204, errors: { ...invalid, 404: errors[404], 409: "Cannot reactivate a user in a deactivated organization." } });
endpoint("post", "/system-admin/tenant-users/{userId}/revoke-sessions", "Platform Tenant Users", "Force tenant-user logout", "Revokes the resolved tenant user's sessions without changing account state or assignments. Zero sessions is success.", { access: "systemAdmin", status: 204, errors: { ...invalid, 404: errors[404] } });
endpoint("get", "/system-admin/overview", "Platform Overview", "Current platform organization and tenant-user counts", "Counts organization activation states and tenant-user activation states separately, plus all tenant roles. User active means the user's own deactivatedAt is null, independently of organization state. No ticket analytics.", { access: "systemAdmin", result: ref("PlatformOverview"), noStore: true });

endpoint("get", "/statistics/overview", "Statistics", "Tenant ticket overview", "ORGANIZATION_ADMIN only. Excludes currently voided tickets. Active means OPEN/IN_PROGRESS/RESOLVED. unassigned means neither team nor agent; urgent and byPriority count active tickets only. byStatus includes CLOSED. today uses UTC createdAt/current closedAt. Average close time covers currently CLOSED tickets; nullable durations mean no qualifying tickets. Cached snapshots may be reused for 30 seconds; generatedAt remains the original snapshot time.", { result: ref("StatisticsOverview"), noStore: true, cache: true, errors: { 403: errors[403] }, responseExample: { generatedAt: sampleDate, tickets: { active: 4, unassigned: 1, urgent: 1, oldestActiveTicketAgeSeconds: 3600, byStatus: { OPEN: 2, IN_PROGRESS: 1, RESOLVED: 1, CLOSED: 1 }, byPriority: { LOW: 0, NORMAL: 2, HIGH: 1, URGENT: 1 } }, today: { created: 3, closed: 1 }, resolution: { averageCloseTimeSeconds: 1800 } } });
endpoint("get", "/statistics/workload", "Statistics", "Tenant assignment workload", "ORGANIZATION_ADMIN only. Active non-voided tickets (OPEN/IN_PROGRESS/RESOLVED). The four assignment categories partition all these tickets. Team counts use only explicit ticket team assignment, never an agent's current team. Direct agent assignment counts both agent-only and team+agent, never team-only. Includes active teams/agents with zero workload; ordered by name then ID. Cached snapshots may be reused for 30 seconds.", { result: ref("StatisticsWorkload"), noStore: true, cache: true, errors: { 403: errors[403] }, responseExample: { generatedAt: sampleDate, assignment: { fullyUnassigned: 1, teamOnly: 2, agentOnly: 1, teamAndAgent: 3 }, teams: [{ teamId: sampleId, teamName: "Technical", activeTickets: 5, teamOnlyTickets: 2, teamAndAgentTickets: 3 }], agents: [{ agentId: "00000000-0000-4000-8000-000000000002", agentName: "Example Agent", activeAssignedTickets: 4 }] } });
endpoint("get", "/statistics/activity", "Statistics", "Daily created and closed ticket activity", "ORGANIZATION_ADMIN only. Inclusive UTC calendar range ending today, based on one database timestamp. Exactly days chronological points, including zero-activity days. Excludes currently voided tickets. Closed counts use current closedAt, not historical closing events; reopening and closing again changes attribution. Totals sum the returned points. Cached separately by organization and days for up to 60 seconds; hits preserve generatedAt. Unknown query keys are rejected.", { parameters: [parameter("days", { type: "integer", minimum: 7, maximum: 90, default: 30 }, "Positive decimal integer with no leading zeroes. Range includes today; from is today minus days-1 UTC days.")], result: ref("StatisticsActivity"), noStore: true, cache: true, errors: { ...invalid, 403: errors[403] }, responseExample: { generatedAt: sampleDate, days: 7, from: "2026-09-12", to: "2026-09-18", totals: { created: 2, closed: 1 }, points: [
  { date: "2026-09-12", created: 1, closed: 0 }, { date: "2026-09-13", created: 0, closed: 0 },
  { date: "2026-09-14", created: 0, closed: 1 }, { date: "2026-09-15", created: 0, closed: 0 },
  { date: "2026-09-16", created: 0, closed: 0 }, { date: "2026-09-17", created: 0, closed: 0 },
  { date: "2026-09-18", created: 1, closed: 0 },
] } });

endpoint("get", "/api-docs", "Documentation", "Swagger UI", "Local, public interactive API documentation. The slashless URL redirects to /api-docs/ where Swagger UI and its local assets are served.", { access: "public", result: string, contentType: "text/html" });
paths["/api-docs"]!.get = {
  ...(paths["/api-docs"]!.get as Record<string, unknown>),
  responses: {
    "301": { description: "Redirect to /api-docs/.", headers: { Location: { schema: string, description: "/api-docs/" }, "X-Request-Id": requestIdHeader } },
    "200": { description: "Swagger UI HTML at /api-docs/.", content: { "text/html": { schema: string } }, headers: { "X-Request-Id": requestIdHeader } },
  },
};
endpoint("get", "/openapi.json", "Documentation", "Raw OpenAPI document", "The same centralized specification rendered by Swagger UI.", { access: "public", result: { type: "object", additionalProperties: true }, noStore: true });

export const openapi = {
  openapi: "3.1.0",
  info: {
    title: "Multi-Tenant Helpdesk API",
    version: "1.0.0",
    description: `Current implemented HTTP contract. Normal tenant endpoints derive organization identity exclusively from the authenticated session; do not send organizationId unless an operation explicitly documents it.

Tenant browser flow: POST /auth/login (or customer slug login) with X-Helpdesk-Client: web; the browser stores the HttpOnly session cookie. GET /auth/csrf, then supply the returned token in X-CSRF-Token for protected mutations. There is no bearer/JWT authentication. Authenticate on this same origin when using Swagger UI: browsers supply cookies automatically and do not let JavaScript manually set the Cookie header. Swagger's cookie authorization fields are descriptive, not a way to set HttpOnly cookies. Use Authorize for the session-bound CSRF header after fetching it.

SYSTEM_ADMIN flow is separate: password login issues only an MFA challenge; /mfa or /recovery exchanges it for the privileged session cookie. The challenge alone cannot access protected administrative routes. SYSTEM_ADMIN CSRF and login throttling are not currently implemented. All session cookies are HttpOnly and SameSite=Strict; Secure depends on local configuration. Session validity is server-controlled; deactivation, revocation and idle/absolute expiration invalidate access.

JSON bodies documented as objects reject unknown keys. Endpoints without a documented body do not validate a body; do not infer strict empty-body validation there. EmptyInput endpoints accept an omitted body or {}. Malformed JSON returns HTTP 400 with {error: "Invalid JSON body"}. Requests that fall through all mounted routes return HTTP 404 with {error: "Route not found"}. Middleware on protected router prefixes may reject unauthenticated or unauthorized requests before that fallback. Normal AppError responses use {error, details?}. X-Request-Id is returned on every request.

Examples use fictional identities and placeholders, never real credentials. Credential fields without examples require your own values. Swagger UI executes real operations on this server when Try it out is used.`,
  },
  servers: [{ url: "/", description: "Same-origin API (local default: http://localhost:3000)." }],
  tags: [
    "Operations", "Organization Registration", "Authentication", "Sessions", "Customer Onboarding",
    "Teams", "Agents", "Invitations", "Tickets", "Ticket Messages", "Internal Notes",
    "System Admin Authentication", "System Admin Sessions", "Platform Organizations",
    "Platform Tenant Users", "Platform Overview", "Statistics", "Documentation",
  ].map((name) => ({ name })),
  components: {
    securitySchemes: {
      tenantSession: { type: "apiKey", in: "cookie", name: "session", description: "Opaque tenant session set by tenant login; browser-managed HttpOnly cookie, Path=/." },
      csrfToken: { type: "apiKey", in: "header", name: "X-CSRF-Token", description: "Fetch from GET /auth/csrf for the current tenant session. Required together with the tenant session on protected mutations." },
      systemAdminSession: { type: "apiKey", in: "cookie", name: "system_admin_session", description: "Fully authenticated SYSTEM_ADMIN cookie, issued only after successful MFA, Path=/system-admin." },
      mfaChallenge: { type: "apiKey", in: "cookie", name: "system_admin_mfa_challenge", description: "Five-minute password-step challenge, Path=/system-admin/auth. Not a privileged session; maximum five failed second-factor attempts." },
    },
    schemas,
  },
  paths,
};
