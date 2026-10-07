import { setTokenProvider } from "@step-up/shared";
import { getAccessToken } from "./auth.js";

// Node-side token source (MSAL device-code + on-disk cache); the shared Graph client stays environment-agnostic.
setTokenProvider(getAccessToken);

export { graphFetch, graphJson, GraphError } from "@step-up/shared";
