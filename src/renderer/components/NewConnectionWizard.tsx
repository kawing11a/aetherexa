import { useEffect, useState } from 'react';
import type { ConnectionCatalog, ConnectionProfile, FileTransferProfile } from '@shared/profiles';
import type { ProfileSaveInput } from '@shared/contracts';
import { ConnectionWizard } from './ConnectionWizard.js';
import { FileTypeWizard } from './FileTypeWizard.js';
import { ProfileDialog } from './ProfileDialog.js';
import { FileTransferProfileDialog } from './FileTransferProfileDialog.js';
import { getSection, transferProtocols } from './connectionSections.js';
import type { ConnectionSection } from './connectionSections.js';

export type WizardLaunch = { section?: ConnectionSection; group?: string };
type WizardStep = { kind: 'choose' } | { kind: 'protocol' } | { kind: 'database' | 'ssh' } | { kind: 'file'; protocol: FileTransferProfile['protocol'] };

type Props = {
  launch: WizardLaunch;
  catalog: ConnectionCatalog;
  profiles: ConnectionProfile[];
  onClose(): void;
  onSave(input: ProfileSaveInput): Promise<boolean>;
  onSaveTemplate(template: ConnectionCatalog['templates'][number]): Promise<boolean>;
  onCreateGroup(name: string): Promise<boolean>;
};

function initialStep(launch: WizardLaunch): WizardStep {
  if (!launch.section) return { kind: 'choose' };
  const target = getSection(launch.section).wizard;
  return target === 's3' ? { kind: 'file', protocol: 's3' } : target === 'file-protocol' ? { kind: 'protocol' } : { kind: target };
}

export function NewConnectionWizard({ launch, catalog, profiles, onClose, onSave, onSaveTemplate, onCreateGroup }: Props) {
  const [step, setStep] = useState<WizardStep>(() => initialStep(launch));
  const scoped = Boolean(launch.section);
  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [onClose]);
  const shared = { groups: catalog.groups, templates: catalog.templates, reusableValues: catalog.reusableValues, profiles, initialGroup: launch.group, wizard: true, onClose, onSave, onSaveTemplate, onCreateGroup };
  const availableProtocols = launch.section === 'files' ? transferProtocols : undefined;
  return <>
    {step.kind === 'choose' && <ConnectionWizard onClose={onClose} onChoose={(target) => setStep(target === 'files' ? { kind: 'protocol' } : { kind: target })} />}
    {step.kind === 'protocol' && <FileTypeWizard protocols={availableProtocols} stepLabel={scoped ? 'Step 1 of 2' : 'Step 2 of 3'} onClose={onClose} onBack={() => scoped ? onClose() : setStep({ kind: 'choose' })} onChoose={(protocol) => setStep({ kind: 'file', protocol })} />}
    <ProfileDialog {...shared} kind="database" visible={step.kind === 'database'} stepLabel={scoped ? undefined : 'Step 2 of 2'} onBack={scoped ? undefined : () => setStep({ kind: 'choose' })} />
    <ProfileDialog {...shared} kind="ssh" visible={step.kind === 'ssh'} stepLabel={scoped ? undefined : 'Step 2 of 2'} onBack={scoped ? undefined : () => setStep({ kind: 'choose' })} />
    {(['sftp', 'ftp', 'ftps-explicit', 'ftps-implicit', 's3'] as const).map((protocol) => <FileTransferProfileDialog {...shared} key={protocol} initialProtocol={protocol} visible={step.kind === 'file' && step.protocol === protocol} stepLabel={launch.section === 'bucket' ? undefined : scoped ? 'Step 2 of 2' : 'Step 3 of 3'} onBack={launch.section === 'bucket' ? undefined : () => setStep({ kind: 'protocol' })} />)}
  </>;
}
