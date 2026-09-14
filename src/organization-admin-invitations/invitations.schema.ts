import { createInvitationSchema as agentInvitationSchema } from "../agent-invitations/invitations.schema.js";

export const createInvitationSchema = agentInvitationSchema
  .pick({ name: true, email: true })
  .strict();

export { invitationListSchema, invitationParamsSchema } from "../agent-invitations/invitations.schema.js";
