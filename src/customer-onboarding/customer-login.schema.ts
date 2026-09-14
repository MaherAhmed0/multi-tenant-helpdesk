import { loginSchema } from "../auth/login/login.schema.js";

export const customerLoginSchema = loginSchema.pick({
  email: true,
  password: true,
}).strict();
