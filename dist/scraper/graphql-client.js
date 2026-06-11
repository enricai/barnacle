"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createGraphqlClient = createGraphqlClient;
const http_client_1 = require("../scraper/http-client");
function createGraphqlClient(options) {
    const { schema, bottleneck, baseHeaders, endpoint } = options;
    const httpClient = (0, http_client_1.createHttpClient)({ schema, bottleneck, baseHeaders });
    return (operationName, query, variables, requestOptions) => httpClient(endpoint, {
        method: "POST",
        body: JSON.stringify({ operationName, query, variables }),
        signal: requestOptions?.signal,
    });
}
//# sourceMappingURL=graphql-client.js.map