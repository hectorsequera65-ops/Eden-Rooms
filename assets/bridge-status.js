export function showBridgeStatus(target, state, message) {
  target.dataset.state = state;
  target.textContent = message;
}

export function showBridgeSaveSuccess(target) {
  showBridgeStatus(target, 'success', 'Sala guardada correctamente en la PS5.');
}
