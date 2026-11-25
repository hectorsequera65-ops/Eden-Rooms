export function showBridgeStatus(target, state, message) {
  target.dataset.state = state;
  target.textContent = message;
}

export function showBridgeSaveSuccess(target) {
  showBridgeStatus(target, 'success', 'Eden Bridge confirmó el envío de la sala.');
}
