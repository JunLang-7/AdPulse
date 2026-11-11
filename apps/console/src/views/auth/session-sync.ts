// This is only a cache-invalidation hint, never a credential or an authorization decision.
const KEY = "adpulse.auth.identity";
const CHANNEL = "adpulse.auth";

export function announceSessionIdentity(userId: string | null): void {
	const value = JSON.stringify(userId);
	try {
		if (window.localStorage.getItem(KEY) === value) return;
		window.localStorage.setItem(KEY, value);
	} catch {
		// BroadcastChannel still works when persistent storage is unavailable.
	}
	try {
		if (typeof BroadcastChannel !== "undefined") {
			const channel = new BroadcastChannel(CHANNEL);
			channel.postMessage(userId);
			channel.close();
		}
	} catch {
		// Storage events and focus revalidation remain available.
	}
}

export function watchSessionIdentity(
	currentUserId: () => string | undefined,
	onChange: () => void,
): () => void {
	const receive = (value: unknown) => {
		if ((value === null || typeof value === "string") && value !== currentUserId())
			onChange();
	};
	const storage = (event: StorageEvent) => {
		if (event.key !== KEY || event.storageArea !== window.localStorage) return;
		try {
			receive(event.newValue === null ? null : JSON.parse(event.newValue));
		} catch {
			// Ignore malformed hints; the server remains the source of identity.
		}
	};
	window.addEventListener("storage", storage);
	let channel: BroadcastChannel | null = null;
	try {
		if (typeof BroadcastChannel !== "undefined") {
			channel = new BroadcastChannel(CHANNEL);
			channel.onmessage = (event) => receive(event.data);
		}
	} catch {
		// Some browser policies disable BroadcastChannel.
	}
	return () => {
		window.removeEventListener("storage", storage);
		channel?.close();
	};
}
