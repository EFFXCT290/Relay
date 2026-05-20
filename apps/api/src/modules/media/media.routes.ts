import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";

// HTTP routes for the media domain. Register in server.ts once defined.
// Pattern: handlers call media.service.ts — never inline business logic.
const mediaRoutes: FastifyPluginAsyncTypebox = async (_app) => {
  // Routes go here.
};

export default mediaRoutes;
