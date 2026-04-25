import { ParamProfileManager } from '../ui/paramProfiles';

/** Minimal workspaceState mock backed by an in-memory Map. */
function makeWorkspaceState() {
    const store = new Map<string, unknown>();
    return {
        get<T>(key: string): T | undefined { return store.get(key) as T | undefined; },
        async update(key: string, value: unknown): Promise<void> { store.set(key, value); },
        keys(): readonly string[] { return [...store.keys()]; },
        setKeysForSync(): void { /* no-op */ },
    };
}

describe('ParamProfileManager', () => {
    const xsltPath = '/workspace/transform.xslt';
    const params = { docDate: '2026-01-01', id: 'INV-001' };
    const automations = { docDate: 'today', id: 'manual' };

    let manager: ParamProfileManager;

    beforeEach(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        manager = new ParamProfileManager(makeWorkspaceState() as any);
    });

    it('listProfiles returns empty array when no profiles saved', () => {
        expect(manager.listProfiles(xsltPath)).toEqual([]);
    });

    it('loadProfile returns undefined for unknown profile', () => {
        expect(manager.loadProfile(xsltPath, 'nonexistent')).toBeUndefined();
    });

    it('saveProfile then listProfiles shows the name', async () => {
        await manager.saveProfile(xsltPath, 'Invoice', params, automations);
        expect(manager.listProfiles(xsltPath)).toEqual(['Invoice']);
    });

    it('loadProfile returns saved data', async () => {
        await manager.saveProfile(xsltPath, 'Invoice', params, automations);
        const profile = manager.loadProfile(xsltPath, 'Invoice');
        expect(profile).toBeDefined();
        expect(profile!.name).toBe('Invoice');
        expect(profile!.params).toEqual(params);
        expect(profile!.automations).toEqual(automations);
    });

    it('saveProfile overwrites profile with the same name', async () => {
        await manager.saveProfile(xsltPath, 'Invoice', { id: 'old' }, {});
        await manager.saveProfile(xsltPath, 'Invoice', { id: 'new' }, { id: 'uuid' });

        expect(manager.listProfiles(xsltPath)).toHaveLength(1);
        expect(manager.loadProfile(xsltPath, 'Invoice')!.params).toEqual({ id: 'new' });
    });

    it('multiple profiles stored independently', async () => {
        await manager.saveProfile(xsltPath, 'Invoice', { id: 'INV' }, {});
        await manager.saveProfile(xsltPath, 'CreditNote', { id: 'CN' }, {});

        const names = manager.listProfiles(xsltPath);
        expect(names).toContain('Invoice');
        expect(names).toContain('CreditNote');
        expect(names).toHaveLength(2);
    });

    it('deleteProfile removes the named profile', async () => {
        await manager.saveProfile(xsltPath, 'Invoice', params, automations);
        await manager.deleteProfile(xsltPath, 'Invoice');
        expect(manager.listProfiles(xsltPath)).toEqual([]);
        expect(manager.loadProfile(xsltPath, 'Invoice')).toBeUndefined();
    });

    it('deleteProfile is a no-op for unknown profile', async () => {
        await manager.saveProfile(xsltPath, 'Invoice', params, automations);
        await manager.deleteProfile(xsltPath, 'nonexistent');
        expect(manager.listProfiles(xsltPath)).toEqual(['Invoice']);
    });

    it('profiles are isolated by xsltPath', async () => {
        const other = '/workspace/other.xslt';
        await manager.saveProfile(xsltPath, 'Profile A', params, automations);
        expect(manager.listProfiles(other)).toEqual([]);
        expect(manager.loadProfile(other, 'Profile A')).toBeUndefined();
    });

    it('deleteProfile leaves other profiles intact', async () => {
        await manager.saveProfile(xsltPath, 'A', { x: '1' }, {});
        await manager.saveProfile(xsltPath, 'B', { x: '2' }, {});
        await manager.deleteProfile(xsltPath, 'A');

        expect(manager.listProfiles(xsltPath)).toEqual(['B']);
        expect(manager.loadProfile(xsltPath, 'B')!.params).toEqual({ x: '2' });
    });

    it('listAllProfiles groups saved profiles by stylesheet path', async () => {
        const other = '/workspace/other.xslt';
        await manager.saveProfile(xsltPath, 'Invoice', params, automations);
        await manager.saveProfile(other, 'CreditNote', { id: 'CN-1' }, { id: 'manual' });

        expect(manager.listAllProfiles()).toEqual([
            {
                xsltPath,
                profiles: [{
                    name: 'Invoice',
                    params,
                    automations,
                }],
            },
            {
                xsltPath: other,
                profiles: [{
                    name: 'CreditNote',
                    params: { id: 'CN-1' },
                    automations: { id: 'manual' },
                }],
            },
        ]);
    });
});
