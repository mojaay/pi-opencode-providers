// One console token drives both providers.
//
// pi stores one credential per provider id, but the console token is
// workspace-scoped and identical for both: it authenticates the V2 catalog and
// the inference requests of Zen and Go alike. The most recently seen credential
// is kept here so the provider that did not run the login can reuse it — its own
// login callback returns this credential without a second approval.

export interface SharedCredential {
	access: string;
	refresh?: string;
	expires?: number;
	orgID?: string;
}

let current: SharedCredential | undefined;

export function rememberCredential(credential: SharedCredential): void {
	if (!credential.access) return;
	current = { ...credential, ...(credential.orgID ? { orgID: credential.orgID } : {}) };
}

/**
 * Remember a bare token seen outside a login. The refresh token and expiry are
 * kept when the same token is seen again, so a later reuse can still be refreshed.
 */
export function rememberToken(value: string, orgID?: string): void {
	if (!value) return;
	const same = current?.access === value;
	current = {
		access: value,
		...(orgID ?? (same ? current?.orgID : undefined) ? { orgID: orgID ?? current?.orgID } : {}),
		...(same && current?.refresh ? { refresh: current.refresh } : {}),
		...(same && current?.expires ? { expires: current.expires } : {}),
	};
}

export function currentCredential(): SharedCredential | undefined {
	return current;
}

export function currentToken(): { value: string; orgID?: string } | undefined {
	return current ? { value: current.access, ...(current.orgID ? { orgID: current.orgID } : {}) } : undefined;
}

export function forgetToken(): void {
	current = undefined;
}
