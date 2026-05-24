import fp from "fastify-plugin";
import {
  S3Client,
  CreateBucketCommand,
  HeadBucketCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl as awsGetSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "../backend-core/runtime/env.js";

declare module "fastify" {
  interface FastifyInstance {
    s3: S3Client;
    getMediaUrl: (storageKey: string) => Promise<string>;
  }
}

export default fp(async (fastify) => {
  const protocol = env.MINIO_USE_SSL ? "https" : "http";
  const s3 = new S3Client({
    endpoint: `${protocol}://${env.MINIO_ENDPOINT}:${env.MINIO_PORT}`,
    region: "us-east-1",
    credentials: {
      accessKeyId:     env.MINIO_ACCESS_KEY,
      secretAccessKey: env.MINIO_SECRET_KEY,
    },
    forcePathStyle: true,
  });

  try {
    await s3.send(new HeadBucketCommand({ Bucket: env.MINIO_BUCKET }));
  } catch (err: unknown) {
    const code = (err as { Code?: string; name?: string }).Code ?? (err as { name?: string }).name;
    if (code === "NoSuchBucket" || code === "NotFound") {
      await s3.send(new CreateBucketCommand({ Bucket: env.MINIO_BUCKET }));
      fastify.log.info({ bucket: env.MINIO_BUCKET }, "minio: bucket created");
    } else {
      fastify.log.warn({ err }, "minio: could not reach storage — uploads will fail until connection is restored");
    }
  }

  fastify.decorate("s3", s3);
  fastify.decorate("getMediaUrl", async (storageKey: string) => {
    const cmd = new GetObjectCommand({ Bucket: env.MINIO_BUCKET, Key: storageKey });
    return awsGetSignedUrl(s3, cmd, { expiresIn: env.MEDIA_SIGNED_URL_EXPIRY });
  });
});
