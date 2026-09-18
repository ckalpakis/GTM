import { env } from 'cloudflare:workers';
import { createIcpScorer } from './icp';
import type { IcpContact, IcpResult } from './db';

/** Persist the binary ICP decision and, for fits only, the 1–5 intent score. */
export async function scoreAgainstICP(contact: IcpContact): Promise<IcpResult> {
  return createIcpScorer(env)(contact);
}
