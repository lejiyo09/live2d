import type { Command, PhysicsRig, PhysicsSetting } from '@l2s/editor-core';

export function setPhysicsGlobals(patch: Partial<Omit<PhysicsRig, 'settings'>>, mergeKey?: string): Command {
  return { label: 'Edit Physics', mergeKey, apply(d) { Object.assign(d.physics, patch); } };
}

export function addPhysicsSetting(s: PhysicsSetting): Command {
  return { label: 'Add Physics Group', apply(d) { d.physics.settings.push(structuredClone(s)); } };
}

export function updatePhysicsSetting(id: string, update: (s: PhysicsSetting) => void, mergeKey?: string): Command {
  return {
    label: 'Edit Physics Group',
    mergeKey,
    apply(d) {
      const s = d.physics.settings.find((x) => x.id === id);
      if (s) update(s);
    },
  };
}

export function deletePhysicsSetting(id: string): Command {
  return { label: 'Delete Physics Group', apply(d) { d.physics.settings = d.physics.settings.filter((s) => s.id !== id); } };
}
