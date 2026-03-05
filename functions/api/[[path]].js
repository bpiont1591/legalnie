import { handleApiRequest } from '../_lib/api.js';

export async function onRequest({ request, env }) {
  return handleApiRequest(request, env);
}
