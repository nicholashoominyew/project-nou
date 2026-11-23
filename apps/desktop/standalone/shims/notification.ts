// Desktop notifications through the browser's own Notification API (the in-page toast still shows when it is not allowed).
export const isPermissionGranted = async () => typeof Notification !== "undefined" && Notification.permission === "granted";
export const requestPermission = async () => (typeof Notification === "undefined" ? "denied" : await Notification.requestPermission());
export const sendNotification = (o: { title: string; body: string }) => { try { new Notification(o.title, { body: o.body }); } catch { /* the toast is enough */ } };
