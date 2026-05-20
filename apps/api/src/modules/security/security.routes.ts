import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";

// HTTP routes for the security domain. Register in server.ts once defined.
// Pattern: handlers call security.service.ts — never inline business logic.
const securityRoutes: FastifyPluginAsyncTypebox = async (_app) => {
  // Routes go here.
};

export default securityRoutes;
