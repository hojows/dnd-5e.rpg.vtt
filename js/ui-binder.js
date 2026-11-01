// js/ui-binder.js
import {CORE_ABILITIES, CORE_SKILLS} from './config.js';
import {dbService} from './db-service.js';
import {getAbilityModifier} from './formula-engine.js';
import {rulesGuard} from './rules-guard.js';

class DomUiBinder {
	cloneTemplate(templateId) {
		const tpl = document.getElementById(templateId);
		if (!tpl || !(tpl instanceof HTMLTemplateElement)) {
			throw new Error(`Template HTML non trovato: #${templateId}`);
		}
		const firstChild = tpl.content.firstElementChild;
		return firstChild ? firstChild.cloneNode(true) : tpl.content.cloneNode(true);
	}

	resolvePath(obj, path) {
		if (!obj || !path) return undefined;
		return path.split('.').reduce((acc, part) => (acc !== undefined && acc !== null ? acc[part] : undefined), obj);
	}

	bindFields(rootEl, data) {
		if (!rootEl || !data) return;

		const applyToElement = (el) => {
			const fieldPath = el.getAttribute('data-field');
			const val = this.resolvePath(data, fieldPath);
			if (val === undefined) return;

			if (el instanceof HTMLInputElement) {
				if (el.type === 'checkbox') {
					el.checked = Boolean(val);
				} else {
					el.value = val ?? '';
				}
			} else if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
				el.value = val ?? '';
			} else {
				el.textContent = val ?? '';
			}
		};

		if (rootEl.hasAttribute && rootEl.hasAttribute('data-field')) {
			applyToElement(rootEl);
		}
		rootEl.querySelectorAll('[data-field]').forEach(applyToElement);
	}

	/**
	 * Mostra o nasconde gli elementi con [data-show-if="flag"] e [data-hide-if="flag"]
	 * ignorando i flag non presenti nell'oggetto passato.
	 */
	bindVisibility(rootEl, flags) {
		if (!rootEl || !flags) return;

		rootEl.querySelectorAll('[data-show-if]').forEach((el) => {
			const key = el.getAttribute('data-show-if');
			const val = this.resolvePath(flags, key);
			if (val === undefined) return;
			el.classList.toggle('hidden', !Boolean(val));
		});

		rootEl.querySelectorAll('[data-hide-if]').forEach((el) => {
			const key = el.getAttribute('data-hide-if');
			const val = this.resolvePath(flags, key);
			if (val === undefined) return;
			el.classList.toggle('hidden', Boolean(val));
		});
	}

	/**
	 * Abilita o disabilita input e pulsanti con [data-enable-if="flag"]
	 * ignorando i flag non presenti nell'oggetto passato.
	 */
	bindEnabled(rootEl, flags) {
		if (!rootEl || !flags) return;

		rootEl.querySelectorAll('[data-enable-if]').forEach((el) => {
			const key = el.getAttribute('data-enable-if');
			const val = this.resolvePath(flags, key);
			if (val === undefined) return;
			const enabled = Boolean(val);
			el.disabled = !enabled;
			el.classList.toggle('opacity-50', !enabled);
			el.classList.toggle('pointer-events-none', !enabled);
		});
	}

	bindActions(rootEl, handlers, contextItem = null) {
		if (!rootEl || !handlers) return;

		const attach = (el) => {
			const actionName = el.getAttribute('data-action');
			const fn = handlers[actionName];
			if (typeof fn !== 'function') return;

			const eventType =
				      el instanceof HTMLInputElement ||
				      el instanceof HTMLSelectElement ||
				      el instanceof HTMLTextAreaElement
				      ? el.getAttribute('data-event') || 'change'
				      : 'click';

			el.addEventListener(eventType, (evt) => {
				fn(evt, el, contextItem);
			});
		};

		if (rootEl.hasAttribute && rootEl.hasAttribute('data-action')) {
			attach(rootEl);
		}
		rootEl.querySelectorAll('[data-action]').forEach(attach);
	}

	renderList(containerEl, templateId, items, setupRowFn, emptyStateEl = null) {
		if (!containerEl) return;
		containerEl.replaceChildren();

		const list = Array.isArray(items) ? items : [];
		if (emptyStateEl) {
			emptyStateEl.classList.toggle('hidden', list.length > 0);
		}

		const fragment = document.createDocumentFragment();
		list.forEach((item, index) => {
			const node = this.cloneTemplate(templateId);
			setupRowFn(node, item, index);
			fragment.appendChild(node);
		});
		containerEl.appendChild(fragment);
	}

	updateDbStatusWidget(rootEl, dbState) {
		if (!rootEl || !dbState) return;
		const labelMap = {
			idle: 'DB in attesa',
			initializing: 'Inizializzazione SQLite...',
			downloading: `Download ${dbState.pack || 'DB'} (${dbState.progress ?? 0}%)`,
			decompressing: `Decompressione ${dbState.pack || 'DB'}...`,
			ready: `DB Pronto (${dbState.activeLang?.toUpperCase() || 'ITA'} v${dbState.coreVersion || '1.0'})`,
			error: `Errore DB: ${dbState.error || 'Sconosciuto'}`
		};

		this.bindFields(rootEl, {
			dbStatusText: labelMap[dbState.status] || dbState.status,
			dbProgressPct: `${dbState.progress ?? 0}%`
		});

		const progressBar = rootEl.querySelector('[data-role="db-progress-bar"]');
		if (progressBar) {
			progressBar.style.width = `${dbState.progress ?? 0}%`;
		}

		this.bindVisibility(rootEl, {
			isDownloadingDb: dbState.status === 'downloading' || dbState.status === 'decompressing',
			isDbReady: dbState.status === 'ready',
			isDbError: dbState.status === 'error'
		});
	}

	prependDiceLogEntry(containerEl, templateId, rollEntry, maxEntries = 40) {
		if (!containerEl || !rollEntry) return;
		const node = this.cloneTemplate(templateId);

		const rollsBreakdown = (rollEntry.rolls || [])
			.map((r) => `[${r.rolls.join(', ')}]`)
			.join(' + ');

		const advLabel =
			      rollEntry.advantage > 0 ? 'VANTAGGIO' : rollEntry.advantage < 0 ? 'SVANTAGGIO' : '';

		this.bindFields(node, {
			rollerName: rollEntry.rollerName || 'Giocatore',
			rollLabel: rollEntry.label || rollEntry.notation,
			notation: rollEntry.notation,
			rollsBreakdown: rollsBreakdown || rollEntry.expression,
			total: rollEntry.total,
			advantageBadge: advLabel,
			time: new Date(rollEntry.timestamp || Date.now()).toLocaleTimeString('it-IT', {
				hour: '2-digit',
				minute: '2-digit',
				second: '2-digit'
			})
		});

		this.bindVisibility(node, {
			hasAdvantageBadge: Boolean(advLabel)
		});

		containerEl.prepend(node);
		while (containerEl.children.length > maxEntries) {
			containerEl.removeChild(containerEl.lastElementChild);
		}
	}

	async renderCharacterSheet(rootEl, character, campaignManifest, actionHandlers = {}) {
		if (!rootEl || !character) return;

		const lang = dbService.activeLang || 'ita';
		const perms = rulesGuard.getPermissions(character, campaignManifest);
		const level = Number(character.level) || 1;
		const proficiencyBonus = Math.ceil(level / 4) + 1;
		const customRegistry = campaignManifest?.customCompendium || null;

		this.bindFields(rootEl, {
			name: character.name || 'Senza Nome',
			level,
			proficiencyBonus: `+${proficiencyBonus}`,
			race: character.race || '-',
			classesRaw: character.classesRaw || '-',
			background: character.background || '-',
			alignment: character.alignment || '-',
			experience: character.experience || 0,
			inspiration: Boolean(character.inspiration),
			hp: {
				current: character.hp?.current ?? 10,
				max: character.hp?.max ?? 10,
				temp: character.hp?.temp ?? 0
			},
			money: {
				pp: character.money?.pp ?? 0,
				gp: character.money?.gp ?? 0,
				ep: character.money?.ep ?? 0,
				sp: character.money?.sp ?? 0,
				cp: character.money?.cp ?? 0
			},
			notes: character.notes || '',
			campaignBadgeText: perms.isCampaignBound
			                   ? `Campagna: ${campaignManifest.campaignName} (Max Liv. ${perms.maxAllowedLevel})`
			                   : 'Modalità Garage (Modifica Libera)'
		});

		this.bindVisibility(rootEl, perms);
		this.bindEnabled(rootEl, perms);

		const abilitiesContainer = rootEl.querySelector('[data-list="abilities"]');
		this.renderList(abilitiesContainer, 'tpl-ability-card', CORE_ABILITIES, (node, ab) => {
			const score = Number(character.abilities?.[ab.key] ?? 10);
			const mod = getAbilityModifier(score);
			const modFormatted = mod >= 0 ? `+${mod}` : `${mod}`;

			this.bindFields(node, {
				abilityKey: ab.key.toUpperCase(),
				abilityLabel: lang === 'ita' ? ab.full_ita : ab.full_eng,
				score,
				modifier: modFormatted
			});

			this.bindEnabled(node, perms);
			this.bindActions(node, actionHandlers, {abilityKey: ab.key, label: ab.full_ita, mod});
		});

		const skillsContainer = rootEl.querySelector('[data-list="skills"]');
		const profSkillsStr = (character.skills || '').toLowerCase();

		this.renderList(skillsContainer, 'tpl-skill-row', CORE_SKILLS, (node, sk) => {
			const isProficient =
				profSkillsStr.includes(sk.key.toLowerCase()) ||
				profSkillsStr.includes(sk.label_ita.toLowerCase());
			const baseMod = getAbilityModifier(character.abilities?.[sk.ability] ?? 10);
			const totalBonus = baseMod + (isProficient ? proficiencyBonus : 0);
			const bonusFormatted = totalBonus >= 0 ? `+${totalBonus}` : `${totalBonus}`;

			this.bindFields(node, {
				skillName: lang === 'ita' ? sk.label_ita : sk.label_eng,
				abilityTag: sk.ability.toUpperCase(),
				bonus: bonusFormatted,
				proficientMarker: isProficient ? '●' : '○'
			});

			this.bindActions(node, actionHandlers, {
				skillKey: sk.key,
				label: lang === 'ita' ? sk.label_ita : sk.label_eng,
				bonus: totalBonus
			});
		});

		const spellsContainer = rootEl.querySelector('[data-list="spells"]');
		const hydratedSpells = await Promise.all(
			(character.spells || []).map((sp) => dbService.hydrateEntry('spells', sp, customRegistry))
		);

		this.renderList(
			spellsContainer,
			'tpl-spell-row',
			hydratedSpells,
			(node, sp, idx) => {
				const displayName = sp.name || sp.customData?.name || `Incantesimo #${sp.dbId}`;
				const spellLevel = sp.level ?? sp.customData?.level ?? 0;
				const school = sp.school || sp.customData?.school || '';
				const description = sp.description || sp.customData?.text || '';

				this.bindFields(node, {
					name: displayName,
					levelLabel: spellLevel === 0 ? 'Trucchetto' : `Liv. ${spellLevel}`,
					school,
					castingTime: sp.casting_time || '-',
					range: sp.range_area || '-',
					duration: sp.duration || '-',
					description,
					prepared: Boolean(sp.prepared),
					sourceBadge: sp.isCustom ? 'CUSTOM' : sp.source || 'PHB'
				});

				this.bindActions(node, actionHandlers, {index: idx, entry: sp, name: displayName});
			},
			rootEl.querySelector('[data-empty="spells"]')
		);

		const itemsContainer = rootEl.querySelector('[data-list="items"]');
		const hydratedItems = await Promise.all(
			(character.items || []).map((it) => dbService.hydrateEntry('items', it, customRegistry))
		);

		this.renderList(
			itemsContainer,
			'tpl-item-row',
			hydratedItems,
			(node, it, idx) => {
				const displayName = it.name || it.customData?.name || `Oggetto #${it.dbId}`;
				const description = it.description || it.customData?.text || '';

				this.bindFields(node, {
					name: displayName,
					count: it.count ?? 1,
					equipped: Boolean(it.equipped),
					rarity: it.rarity || 'Comune',
					damage: it.damage || '',
					ac: it.ac ? `CA ${it.ac}` : '',
					description,
					sourceBadge: it.isCustom ? 'CUSTOM' : it.source || 'PHB'
				});

				this.bindActions(node, actionHandlers, {index: idx, entry: it, name: displayName});
			},
			rootEl.querySelector('[data-empty="items"]')
		);

		const featsContainer = rootEl.querySelector('[data-list="feats"]');
		const hydratedFeats = await Promise.all(
			(character.feats || []).map((ft) => dbService.hydrateEntry('feats', ft, customRegistry))
		);

		this.renderList(
			featsContainer,
			'tpl-feat-row',
			hydratedFeats,
			(node, ft, idx) => {
				const displayName = ft.name || ft.customData?.name || `Talento #${ft.dbId}`;
				const description = ft.description || ft.customData?.text || '';

				this.bindFields(node, {
					name: displayName,
					prerequisite: ft.prerequisite || '',
					description,
					sourceBadge: ft.isCustom ? 'CUSTOM' : ft.source || 'PHB'
				});

				this.bindActions(node, actionHandlers, {index: idx, entry: ft, name: displayName});
			},
			rootEl.querySelector('[data-empty="feats"]')
		);
	}
}

export const uiBinder = new DomUiBinder();