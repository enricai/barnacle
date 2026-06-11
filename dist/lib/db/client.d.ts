import { PrismaClient } from "../../generated/prisma/client";
/**
 * Reuses a single Prisma client across `tsx watch` reloads in
 * development — otherwise each reload leaks a connection and the pg
 * pool starts rejecting new clients after a few saves.
 */
export declare const prisma: PrismaClient;
