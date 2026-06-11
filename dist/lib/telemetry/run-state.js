"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getTelemetryState = getTelemetryState;
exports.setTelemetryState = setTelemetryState;
exports.resetTelemetryState = resetTelemetryState;
let state = {
    currentRunFile: null,
    currentRunFileSizeBytes: 0,
    orphansRecovered: 0,
};
/** Exposes the current run state to health.ts without coupling it to the event-stream writer. */
function getTelemetryState() {
    return { ...state };
}
/** Allows the event-stream subsystem (or tests) to update state without importing health.ts. */
function setTelemetryState(partial) {
    state = { ...state, ...partial };
}
/** Restores initial defaults between test cases so state doesn't bleed across tests. */
function resetTelemetryState() {
    state = { currentRunFile: null, currentRunFileSizeBytes: 0, orphansRecovered: 0 };
}
//# sourceMappingURL=run-state.js.map