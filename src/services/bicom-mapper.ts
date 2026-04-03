import crypto from 'crypto';

const STRATEGY_MAP: Record<string, string> = {
  ringall: 'simultaneous',
  hunt: 'sequential',
  leastrecent: 'least_recent',
  fewestcalls: 'fewest_calls',
  random: 'random',
  rrmemory: 'round_robin',
};

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
}

function normaliseNumber(num: string | null | undefined): string | null {
  if (!num) return null;
  const n = String(num).replace(/\s+/g, '').replace(/^\+/, '');
  if (n.startsWith('44')) return '+' + n;
  if (n.startsWith('0')) return '+44' + n.slice(1);
  return '+' + n;
}

export class BiComMapper {
  mapTenantToOrg(tenant: any, bicomTenantId: string) {
    const name = tenant.name || tenant.company || `Tenant ${bicomTenantId}`;
    return {
      name,
      slug: `${slugify(name)}-${bicomTenantId}`.slice(0, 50),
      type: 'org',
      settings: { bicom_tenant_id: bicomTenantId },
      plan: 'soniq',
      country: 'GB',
    };
  }

  mapExtension(ext: any, orgId: string) {
    const extension = String(ext.extension || ext.exten || ext.number);
    const displayName = ext.name || ext.callerid || extension;
    const rawPassword = ext.secret || ext.sip_secret || crypto.randomBytes(8).toString('hex');

    const orgUser = {
      org_id: orgId,
      extension,
      display_name: displayName,
      email: ext.email || null,
      caller_id_name: displayName,
      caller_id_number: normaliseNumber(ext.callerid_number || null),
      voicemail_enabled: ext.voicemail === '1' || ext.voicemail === true,
      voicemail_pin: ext.vmsecret || null,
      dnd_enabled: ext.dnd === '1' || ext.dnd === true,
      settings: {
        cli_default: normaliseNumber(ext.callerid_number || null),
        cli_emergency: normaliseNumber(ext.emergency_cid || null),
        ring_timeout: parseInt(ext.ringtime || ext.ring_timeout || '20'),
        voicemail: { enabled: ext.voicemail === '1', pin: ext.vmsecret || null },
        dnd: ext.dnd === '1',
        forward_on_busy: ext.call_forward_busy || null,
        forward_on_noanswer: ext.call_forward_noanswer || null,
        bicom_ext_id: ext.id,
      },
    };

    const sipCred = {
      org_id: orgId,
      extension,
      username: extension,
      password_hash: rawPassword,
      display_name: displayName,
      enabled: true,
      realm: 'sip.soniqlabs.co.uk',
    };

    return { orgUser, sipCred, rawPassword };
  }

  mapRingGroup(rg: any, orgId: string, orgUsersByExt: Record<string, any>) {
    const members: any[] = [];
    for (const m of (rg.members || rg.extensions || [])) {
      const ext = String(m.extension || m.exten || m);
      const ou = orgUsersByExt[ext];
      if (ou) members.push({ org_user_id: ou.id, priority: parseInt(m.priority || '0'), penalty: 0 });
    }
    return {
      group: {
        org_id: orgId,
        name: rg.name || `Ring Group ${rg.extension}`,
        ring_strategy: STRATEGY_MAP[rg.strategy] || 'simultaneous',
        ring_timeout: parseInt(rg.ringtime || rg.ring_timeout || '20'),
        group_type: 'ring',
        is_active: true,
        settings: { bicom_rg_id: rg.id },
      },
      members,
    };
  }

  mapQueue(q: any, orgId: string, orgUsersByExt: Record<string, any>) {
    const members: any[] = [];
    for (const m of (q.members || q.extensions || [])) {
      const ext = String(m.extension || m.exten || m);
      const ou = orgUsersByExt[ext];
      if (ou) members.push({ org_user_id: ou.id, org_id: orgId, priority: parseInt(m.priority || '0') });
    }
    return {
      queue: {
        org_id: orgId,
        name: q.name || `Queue ${q.extension}`,
        strategy: STRATEGY_MAP[q.strategy] || 'round_robin',
        ring_timeout: parseInt(q.member_timeout || q.ring_timeout || '20'),
        max_callers: parseInt(q.maxlen || '50'),
        is_active: true,
      },
      members,
    };
  }

  mapIVR(ivr: any, orgId: string) {
    const steps: any[] = [];
    if (ivr.greeting || ivr.greeting_text) {
      steps.push({ id: 'play_greeting', type: 'play_audio', audio_url: ivr.greeting_url || null, next: 'menu' });
    }
    const menuStep: any = {
      id: 'menu', type: 'ivr_menu',
      timeout: parseInt(ivr.timeout || '5'),
      options: {},
    };
    for (const opt of (ivr.options || ivr.keys || ivr.dtmf_options || [])) {
      menuStep.options[String(opt.key || opt.digit)] = opt;
    }
    steps.push(menuStep);
    return {
      org_id: orgId,
      name: ivr.name || `IVR ${ivr.extension}`,
      flow_type: 'ivr',
      workflow_steps: steps,
      is_active: true,
      settings: { bicom_ivr_id: ivr.id },
    };
  }

  mapDID(did: any, orgId: string) {
    const number = normaliseNumber(did.did || did.number) || '';
    return {
      flow: {
        org_id: orgId,
        name: `Inbound ${number}`,
        flow_type: 'inbound',
        workflow_steps: [],
        is_active: true,
        settings: { bicom_did_id: did.id },
      },
      phoneNumber: {
        org_id: orgId,
        number,
        country_code: 'GB',
        number_type: 'local',
        status: 'active',
        provider: 'onehub',
        voice_enabled: true,
        sms_enabled: false,
        label: did.name || number,
      },
    };
  }
}
