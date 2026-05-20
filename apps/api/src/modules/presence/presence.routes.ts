import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";

// HTTP routes for the presence domain. Register in server.ts once defined.
// Pattern: handlers call presence.service.ts — never inline business logic.
const presenceRoutes: FastifyPluginAsyncTypebox = async (_app) => {
  // Routes go here.
};

export default presenceRoutes;
