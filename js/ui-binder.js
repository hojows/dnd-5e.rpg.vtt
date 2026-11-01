import {APP_CONFIG} from './config.js';
import {dbService} from './db-service.js';
import {driveService} from './drive-service.js';
import {CORE_ABILITIES, CORE_SKILLS, evaluateFormula, getAbilityModifier} from './formula-engine.js';
import {i18nService} from './i18n-service.js';
import {rulesGuard} from './rules-guard.js';

class DomUiBinder {
	constructor() {
		this._userMenuBound = false;
	}

	/**
	 * Clones an HTML <template> and immediately translates any [data-i18n] nodes inside it.
	 */
	cloneTemplate(templateId) {
		const tpl = document.getElementById(templateId);
		if (!tpl || !(tpl instanceof HTMLTemplateElement)) {
			throw new Error(`HTML Template not found: #${templateId}`);
		}
		const firstChild = tpl.content.firstElementChild;
		const node = firstChild ? firstChild.cloneNode(true) : tpl.content.cloneNode(true);
		i18nService.translateDom(node);
		return node;
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

			if (el instanceof HTMLImageElement) {
				if (val) {
					el.src = val;
					el.classList.remove('hidden');
				} else {
					el.classList.add('hidden');
				}
			} else if (el instanceof HTMLInputElement) {
				if (el.type === 'checkbox') {
					el.checked = Boolean(val);
				} else if (document.activeElement !== el) {
					el.value = val ?? '';
				}
			} else if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
				if (document.activeElement !== el) {
					el.value = val ?? '';
				}
			} else {
				el.textContent = val ?? '';
			}
		};

		if (rootEl.hasAttribute && rootEl.hasAttribute('data-field')) {
			applyToElement(rootEl);
		}
		rootEl.querySelectorAll('[data-field]').forEach(applyToElement);
	}

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

			if (!el._boundActionHandlers) {
				el._boundActionHandlers = new Map();
			}

			const eventType =
				      el instanceof HTMLInputElement ||
				      el instanceof HTMLSelectElement ||
				      el instanceof HTMLTextAreaElement
				      ? el.getAttribute('data-event') || 'change'
				      : 'click';

			const existing = el._boundActionHandlers.get(actionName);
			if (existing) {
				el.removeEventListener(existing.eventType, existing.listener);
			}

			const listener = (evt) => fn(evt, el, contextItem);
			el._boundActionHandlers.set(actionName, {eventType, listener});
			el.addEventListener(eventType, listener);
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

	updateAuthWidget(rootEl, authState) {
		if (!rootEl || !authState) return;
		const isLogged = Boolean(authState.authenticated);
		const pictureUrl = authState.user?.picture || '';
		const userName = authState.user?.name || '';
		const userEmail = authState.user?.email || '';

		rootEl.querySelectorAll('[data-role="auth-logged-out"]').forEach((el) => {
			el.classList.toggle('hidden', isLogged);
		});

		rootEl.querySelectorAll('[data-role="auth-logged-in"]').forEach((el) => {
			el.classList.toggle('hidden', !isLogged);
		});

		rootEl.querySelectorAll('[data-field="userName"]').forEach((el) => {
			el.textContent = userName || userEmail;
		});

		rootEl.querySelectorAll('[data-field="userEmail"]').forEach((el) => {
			el.textContent = userEmail;
		});

		rootEl.querySelectorAll('[data-field="vaultFolder"]').forEach((el) => {
			el.textContent = APP_CONFIG.DRIVE_VAULT_FOLDER || '';
		});

		const showAvatarImg = isLogged && Boolean(pictureUrl);
		rootEl.querySelectorAll('[data-role="user-avatar-img"]').forEach((imgEl) => {
			if (showAvatarImg) {
				imgEl.src = pictureUrl;
				imgEl.classList.remove('hidden');
			} else {
				imgEl.removeAttribute('src');
				imgEl.classList.add('hidden');
			}
		});

		rootEl.querySelectorAll('[data-role="user-avatar-fallback"]').forEach((iconEl) => {
			iconEl.classList.toggle('hidden', showAvatarImg);
		});

		rootEl.querySelectorAll('[data-role="user-status-dot"]').forEach((dotEl) => {
			dotEl.classList.toggle('bg-emerald-400', isLogged);
			dotEl.classList.toggle('bg-zinc-500', !isLogged);
		});

		rootEl.querySelectorAll('[data-role="user-menu-dropdown"]').forEach((dd) => {
			dd.classList.add('hidden');
		});

		this.ensureUserMenuListeners(rootEl);
	}

	ensureUserMenuListeners(rootEl) {
		if (this._userMenuBound) return;
		this._userMenuBound = true;

		document.addEventListener('click', (evt) => {
			const toggleBtn = evt.target.closest('[data-action="toggleUserMenu"]');
			const container = evt.target.closest('[data-role="user-menu-container"]');

			if (toggleBtn && container) {
				evt.stopPropagation();
				const dropdown = container.querySelector('[data-role="user-menu-dropdown"]');
				if (dropdown) {
					dropdown.classList.toggle('hidden');
				}
				return;
			}

			if (!container) {
				rootEl.querySelectorAll('[data-role="user-menu-dropdown"]').forEach((dd) => {
					dd.classList.add('hidden');
				});
			}
		});
	}

	updateDbStatusWidget(rootEl, dbState) {
		if (!rootEl || !dbState) return;
		const widgetEl = rootEl.querySelector('[data-role="db-status-widget"]') || rootEl;
		const lang = (dbState.activeLang || dbService.activeLang || 'eng').toUpperCase();
		const ver =
			(lang === 'ITA' ? dbState.langVersion : dbState.coreVersion) ||
			dbState.coreVersion ||
			'1.0';

		const fallbackMap = {
			idle: 'DB idle',
			initializing: 'Initializing SQLite...',
			downloading: 'Downloading {pack} ({progress}%)',
			decompressing: 'Decompressing {pack}...',
			ready: 'DB Ready ({lang} v{version})',
			error: 'DB Error: {error}'
		};

		const statusKey = dbState.status || 'idle';
		const statusText = i18nService.t(
			`db.${statusKey}`,
			fallbackMap[statusKey] || statusKey,
			{
				pack: dbState.pack || 'DB',
				progress: dbState.progress ?? 0,
				lang,
				version: ver,
				error: dbState.error || 'Unknown'
			}
		);

		this.bindFields(widgetEl, {
			dbStatusText: statusText,
			dbProgressPct: `${dbState.progress ?? 0}%`
		});

		const progressBar = widgetEl.querySelector('[data-role="db-progress-bar"]');
		if (progressBar) {
			progressBar.style.width = `${dbState.progress ?? 0}%`;
		}

		this.bindVisibility(widgetEl, {
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
			      rollEntry.advantage > 0
			      ? i18nService.t('common.advantage', 'ADVANTAGE')
			      : rollEntry.advantage < 0
			        ? i18nService.t('common.disadvantage', 'DISADVANTAGE')
			        : '';

		this.bindFields(node, {
			rollerName: rollEntry.rollerName || 'Player',
			rollLabel: rollEntry.label || rollEntry.notation,
			notation: rollEntry.notation,
			rollsBreakdown: rollsBreakdown || rollEntry.expression,
			total: rollEntry.total,
			advantageBadge: advLabel,
			time: new Date(rollEntry.timestamp || Date.now()).toLocaleTimeString([], {
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

		await driveService.loadActiveImagesMap();
		const portraitUrl = driveService.getImageDataUrl(character.imageUid);

		const perms = rulesGuard.getPermissions(character, campaignManifest);
		const level = Number(character.level) || 1;
		const proficiencyBonus = Math.ceil(level / 4) + 1;
		const customRegistry = campaignManifest?.customCompendium || null;

		const charContext = {
			level,
			proficiencyBonus,
			abilities: character.abilities,
			spellcastingAbility: character.spellcastingAbility || 'int'
		};

		const hitDiceSummary =
			      Array.isArray(character.classes) && character.classes.length > 0
			      ? character.classes
			                 .map((c) => `${c.name}: ${c.hdCurrent ?? c.level}/${c.level}d${c.hdFaces || 8}`)
			                 .join(' • ')
			      : `${level}d8`;

		const badgeText = perms.isCampaignBound
		                  ? i18nService.t('pc.campaignBoundBadge', 'Campaign: {name} (Max Lv. {max})', {
				name: campaignManifest?.campaignName || '',
				max: perms.maxAllowedLevel
			})
		                  : i18nService.t('pc.garageModeBadge', 'Garage Mode (Free Edit)');

		this.bindFields(rootEl, {
			name: character.name || '',
			portraitUrl: portraitUrl || '',
			level,
			proficiencyBonus: `+${proficiencyBonus}`,
			ac: character.ac ?? 10 + getAbilityModifier(character.abilities?.dex ?? 10),
			hitDiceSummary,
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
			companionsCount: Array.isArray(character.companions) ? character.companions.length : 0,
			campaignBadgeText: badgeText
		});

		this.bindVisibility(rootEl, {
			...perms,
			hasPortrait: Boolean(portraitUrl)
		});
		this.bindEnabled(rootEl, perms);
		this.bindActions(rootEl, actionHandlers);

		// 1. Abilities Grid (labels from i18n)
		const abilitiesContainer = rootEl.querySelector('[data-list="abilities"]');
		const saveProfs = new Set(character.savingThrowProficiencies || []);
		const savePrefix = i18nService.t('common.savePrefix', 'ST');

		this.renderList(abilitiesContainer, 'tpl-ability-card', CORE_ABILITIES, (node, ab) => {
			const score = Number(character.abilities?.[ab.key] ?? 10);
			const mod = getAbilityModifier(score);
			const modFormatted = mod >= 0 ? `+${mod}` : `${mod}`;
			const hasSaveProf = saveProfs.has(ab.key);
			const saveBonus = mod + (hasSaveProf ? proficiencyBonus : 0);
			const saveFormatted = saveBonus >= 0 ? `+${saveBonus}` : `${saveBonus}`;
			const fullLabel = i18nService.t(`abilities.${ab.key}.full`, ab.key.toUpperCase());
			const shortLabel = i18nService.t(`abilities.${ab.key}.short`, ab.key.toUpperCase());

			this.bindFields(node, {
				abilityKey: shortLabel,
				abilityLabel: fullLabel,
				score,
				modifier: modFormatted,
				saveBonus: `${savePrefix} ${saveFormatted}`
			});

			this.bindEnabled(node, perms);
			this.bindActions(node, actionHandlers, {
				abilityKey: ab.key,
				label: fullLabel,
				mod,
				saveBonus
			});
		});

		// 2. Attacks & Trackers
		const attacksContainer = rootEl.querySelector('[data-list="attacks"]');
		if (attacksContainer && document.getElementById('tpl-attack-row')) {
			this.renderList(
				attacksContainer,
				'tpl-attack-row',
				character.attacks || [],
				(node, atk) => {
					const hitEval = evaluateFormula(atk.attackBonusFormula, charContext);
					let hitNum = 0;
					try {
						hitNum = Function(`"use strict"; return (${hitEval.expression})`)();
					} catch (_) {}
					const hitFormatted = hitNum >= 0 ? `+${hitNum}` : `${hitNum}`;
					const dmgEval = evaluateFormula(atk.damageFormula, charContext);
					const dmgTypeLabel = atk.damageTypeCode
					                     ? i18nService.t(`damageTypes.${atk.damageTypeCode}`, '')
					                     : atk.damageType || '';

					this.bindFields(node, {
						name: atk.name,
						hitBonus: hitFormatted,
						damageText: `${dmgEval.expression} ${dmgTypeLabel}`.trim()
					});

					this.bindActions(node, actionHandlers, {
						name: atk.name,
						hitBonus: hitNum,
						damageFormula: dmgEval.expression
					});
				},
				rootEl.querySelector('[data-empty="attacks"]')
			);
		}

		const trackersContainer = rootEl.querySelector('[data-list="trackers"]');
		if (trackersContainer && document.getElementById('tpl-tracker-card')) {
			this.renderList(
				trackersContainer,
				'tpl-tracker-card',
				character.trackers || [],
				(node, tr, idx) => {
					const resetLabel =
						      tr.resetType === 1
						      ? i18nService.t('common.shortRest', 'Short Rest')
						      : i18nService.t('common.longRest', 'Long Rest');

					this.bindFields(node, {
						label: tr.label,
						origin: tr.origin || '',
						resetLabel,
						current: tr.current ?? 0,
						max: tr.max ?? 0
					});
					this.bindActions(node, actionHandlers, {index: idx, tracker: tr});
				},
				rootEl.querySelector('[data-empty="trackers"]')
			);
		}

		// 3. Skills (labels from i18n)
		const skillsContainer = rootEl.querySelector('[data-list="skills"]');
		const profSkillsStr = (character.skills || '').toLowerCase();

		this.renderList(skillsContainer, 'tpl-skill-row', CORE_SKILLS, (node, sk) => {
			const localizedSkill = i18nService.t(`skills.${sk.key}`, sk.engKey);
			const localizedAbShort = i18nService.t(`abilities.${sk.ability}.short`, sk.ability.toUpperCase());
			const isProficient =
				profSkillsStr.includes(sk.key.toLowerCase()) ||
				profSkillsStr.includes(sk.engKey.toLowerCase()) ||
				profSkillsStr.includes(localizedSkill.toLowerCase());

			const baseMod = getAbilityModifier(character.abilities?.[sk.ability] ?? 10);
			const totalBonus = baseMod + (isProficient ? proficiencyBonus : 0);
			const bonusFormatted = totalBonus >= 0 ? `+${totalBonus}` : `${totalBonus}`;

			this.bindFields(node, {
				skillName: localizedSkill,
				abilityTag: localizedAbShort,
				bonus: bonusFormatted,
				proficientMarker: isProficient ? '●' : '○'
			});

			this.bindActions(node, actionHandlers, {
				skillKey: sk.key,
				label: localizedSkill,
				bonus: totalBonus
			});
		});

		// 4. Spell Slots & Spells
		const lvShort = i18nService.t('common.levelShort', 'Lv.');
		const cantripLabel = i18nService.t('common.cantrip', 'Cantrip');

		const slotsContainer = rootEl.querySelector('[data-list="spell-slots"]');
		if (slotsContainer && document.getElementById('tpl-spell-slot-badge')) {
			this.renderList(slotsContainer, 'tpl-spell-slot-badge', character.spellSlots || [], (node, sl, idx) => {
				this.bindFields(node, {
					slotTitle:
						sl.type === 'Standard'
						? `${lvShort} ${sl.level}`
						: `${lvShort} ${sl.level} (${sl.type})`,
					current: sl.current ?? sl.max,
					max: sl.max
				});
				this.bindActions(node, actionHandlers, {index: idx, slot: sl});
			});
		}

		const spellsContainer = rootEl.querySelector('[data-list="spells"]');
		const hydratedSpells = await Promise.all(
			(character.spells || []).map((sp) => dbService.hydrateEntry('spells', sp, customRegistry))
		);

		this.renderList(
			spellsContainer,
			'tpl-spell-row',
			hydratedSpells,
			(node, sp, idx) => {
				const displayName = sp.name || sp.customLabel || sp.customData?.name || `#${sp.dbId}`;
				const spellLevel = sp.level ?? sp.customData?.level ?? 0;
				const school = sp.school || sp.customData?.school || '';
				const description = sp.description || sp.customData?.text || '';
				const firstRoll = (sp.rolls || sp.customData?.rolls || [])[0] || '';

				this.bindFields(node, {
					name: displayName,
					levelLabel: spellLevel === 0 ? cantripLabel : `${lvShort} ${spellLevel}`,
					originBadge: sp.origin || sp.customData?.origin || '',
					school,
					castingTime: sp.casting_time || sp.customData?.casting_time || '-',
					range: sp.range_area || sp.customData?.range_area || '-',
					duration: sp.duration || sp.customData?.duration || '-',
					description,
					prepared: Boolean(sp.prepared),
					rollFormula: firstRoll,
					sourceBadge: sp.isCustom ? 'CUSTOM' : sp.source || 'PHB'
				});

				this.bindVisibility(node, {
					hasSpellRoll: Boolean(firstRoll)
				});

				this.bindActions(node, actionHandlers, {
					index: idx,
					entry: sp,
					name: displayName,
					rollFormula: firstRoll
				});
			},
			rootEl.querySelector('[data-empty="spells"]')
		);

		// 5. Items
		const itemsContainer = rootEl.querySelector('[data-list="items"]');
		const hydratedItems = await Promise.all(
			(character.items || []).map((it) => dbService.hydrateEntry('items', it, customRegistry))
		);

		this.renderList(
			itemsContainer,
			'tpl-item-row',
			hydratedItems,
			(node, it, idx) => {
				const displayName = it.name || it.customLabel || it.customData?.name || `#${it.dbId}`;
				const description = it.description || it.customData?.text || '';
				const itemImgUrl = driveService.getImageDataUrl(it.imageUid || it.customData?.imageUid);

				this.bindFields(node, {
					name: displayName,
					itemImgUrl: itemImgUrl || '',
					containerBadge: it.container || it.customData?.container || '',
					count: it.count ?? 1,
					equipped: Boolean(it.equipped),
					rarity: it.rarity || it.customData?.detail || '',
					damage: it.damage || it.customData?.damage || '',
					ac: (it.ac || it.customData?.ac) > 0 ? `AC +${it.ac || it.customData?.ac}` : '',
					description,
					sourceBadge: it.isCustom ? 'CUSTOM' : it.source || 'PHB'
				});

				this.bindVisibility(node, {
					hasItemImage: Boolean(itemImgUrl)
				});

				this.bindActions(node, actionHandlers, {index: idx, entry: it, name: displayName});
			},
			rootEl.querySelector('[data-empty="items"]')
		);

		// 6. Feats & Features
		const featsContainer = rootEl.querySelector('[data-list="feats"]');
		const hydratedFeats = await Promise.all(
			(character.feats || []).map((ft) => dbService.hydrateEntry('feats', ft, customRegistry))
		);

		this.renderList(
			featsContainer,
			'tpl-feat-row',
			hydratedFeats,
			(node, ft, idx) => {
				const displayName = ft.name || ft.customLabel || ft.customData?.name || `#${ft.dbId}`;
				const description = ft.description || ft.customData?.text || '';

				this.bindFields(node, {
					name: displayName,
					originBadge: ft.origin || ft.customData?.origin || '',
					prerequisite: ft.prerequisite || ft.customData?.prerequisite || '',
					description,
					sourceBadge: ft.isCustom ? 'CUSTOM' : ft.source || 'PHB'
				});

				this.bindActions(node, actionHandlers, {index: idx, entry: ft, name: displayName});
			},
			rootEl.querySelector('[data-empty="feats"]')
		);

		// 7. Companions (<monster>, e.g., A.R.G.O.)
		const companionsContainer = rootEl.querySelector('[data-list="companions"]');
		if (companionsContainer && document.getElementById('tpl-companion-card')) {
			this.renderList(
				companionsContainer,
				'tpl-companion-card',
				character.companions || [],
				(node, comp, idx) => {
					const compImgUrl = driveService.getImageDataUrl(comp.imageUid);
					const abStr = CORE_ABILITIES.map((a) => {
						const sc = comp.abilities?.[a.key] ?? 10;
						const m = getAbilityModifier(sc);
						const abShort = i18nService.t(`abilities.${a.key}.short`, a.key.toUpperCase());
						return `${abShort}: ${sc} (${m >= 0 ? `+${m}` : m})`;
					}).join(' | ');

					const savesList = (comp.savingThrows || []).map((st) => {
						if (typeof st === 'string') return st;
						const abShort = i18nService.t(`abilities.${st.abilityKey}.short`, st.abilityKey.toUpperCase());
						return `${abShort} ${st.modifier >= 0 ? `+${st.modifier}` : st.modifier}`;
					});

					const skillsList = (comp.skills || []).map((sk) => {
						if (typeof sk === 'string') return sk;
						const skLabel = i18nService.t(`skills.${sk.skillKey}`, sk.skillKey);
						return `${skLabel} ${sk.modifier >= 0 ? `+${sk.modifier}` : sk.modifier}`;
					});

					const sizeLabel =
						      comp.sizeCode !== undefined
						      ? i18nService.t(`monsterSizes.${comp.sizeCode}`, '')
						      : comp.size || '';

					const traitsText = (comp.traits || []).map((t) => `• ${t.name}: ${t.text}`).join('\n');
					const actionsText = (comp.actions || [])
						.map((act) => {
							const atkDesc = (act.attacks || [])
								.map((at) => `[+${at.attackBonus}, ${at.damage}]`)
								.join(' ');
							return `• ${act.name} ${atkDesc}: ${act.text}`;
						})
						.join('\n');
					const reactionsText = (comp.reactions || []).map((r) => `• ${r.name}: ${r.text}`).join('\n');

					this.bindFields(node, {
						label: comp.label || comp.name,
						name: comp.name,
						companionImgUrl: compImgUrl || '',
						typeAndSize: `${sizeLabel} ${comp.type || ''} (${comp.alignment || ''})`.trim(),
						ac: comp.ac || '10',
						speed: comp.speed || '-',
						hpCurrent: comp.hp?.current ?? 10,
						hpMax: comp.hp?.max ?? 10,
						abilitiesLine: abStr,
						skillsAndSaves: [...savesList, ...skillsList].join(' • ') || '-',
						immunities: [comp.immune, comp.conditionImmune].filter(Boolean).join(' | ') || '-',
						senses: `${comp.senses || ''} (PP ${comp.passivePerception ?? 10})`.trim(),
						text: comp.text || '',
						traitsText,
						actionsText,
						reactionsText
					});

					this.bindVisibility(node, {
						hasCompanionImage: Boolean(compImgUrl)
					});

					this.bindActions(node, actionHandlers, {index: idx, companion: comp});
				},
				rootEl.querySelector('[data-empty="companions"]')
			);
		}
	}
}

export const uiBinder = new DomUiBinder();