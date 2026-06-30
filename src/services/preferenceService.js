import { CONFIG } from '../config.js';
import { classifyDomain } from './summaryService.js';

const {
  VERSION, LEARNING_FACTOR,
  SIGNAL_WORKSPACE_RENAME, SIGNAL_DOMAIN_MOVE,
  SIGNAL_WORKSPACE_MERGE, SIGNAL_ACCEPT,
  SIGNAL_DELETE_IMMEDIATE,
  MAX_CORRECTIONS, MAX_DOMAIN_RULES,
  MAX_WORKSPACE_PATTERNS, MAX_NAMING_PREFERENCES,
  INITIAL_CONFIDENCE, MAX_CONFIDENCE, MIN_CONFIDENCE,
  DECAY_INTERVAL_DAYS, DECAY_FACTOR,
  HIGH_CONFIDENCE_THRESHOLD, LOW_CONFIDENCE_THRESHOLD,
} = CONFIG.PREFERENCE_MEMORY;

const STORAGE_KEY = CONFIG.STORAGE_KEYS.PREFERENCE_MEMORY;

function createDefaultMemory() {
  return {
    version: VERSION,
    enabled: true,
    domainRules: {},
    workspacePatterns: {},
    namingPreferences: {},
    categoryPreferences: {},
    corrections: [],
    statistics: {
      totalCorrections: 0,
      lastUpdated: null,
      lastDecayApplied: null,
    },
  };
}

function extractDomain(url) {
  try {
    const hostname = new URL(url).hostname;
    return hostname.replace(/^www\./, '');
  } catch {
    return 'unknown';
  }
}

function clampConfidence(value) {
  return Math.min(MAX_CONFIDENCE, Math.max(MIN_CONFIDENCE, value));
}

function applyConfidence(current, signalWeight) {
  return clampConfidence(current + signalWeight * LEARNING_FACTOR);
}

function logCorrection(memory, type, data) {
  memory.corrections.push({
    id: crypto.randomUUID(),
    type,
    timestamp: Date.now(),
    data,
  });
  memory.statistics.totalCorrections++;
}

function pruneCorrections(memory) {
  if (memory.corrections.length > MAX_CORRECTIONS) {
    memory.corrections.sort((a, b) => a.timestamp - b.timestamp);
    memory.corrections = memory.corrections.slice(-MAX_CORRECTIONS);
  }
}

function migrateV1ToV2(oldMemory) {
  const newMemory = createDefaultMemory();
  newMemory.enabled = oldMemory.enabled !== undefined ? oldMemory.enabled : true;

  if (oldMemory.domainRules) {
    for (const [domain, rule] of Object.entries(oldMemory.domainRules)) {
      const category = classifyDomain(domain);
      newMemory.domainRules[domain] = {
        preferredWorkspace: rule.preferredWorkspace,
        category: category || undefined,
        confidence: rule.confidence || INITIAL_CONFIDENCE,
        observations: rule.observations || 1,
        lastSeen: rule.lastSeen || Date.now(),
      };
      if (category) {
        newMemory.categoryPreferences[domain] = { category };
      }
    }
  }

  if (oldMemory.workspacePatterns) {
    let idx = 0;
    for (const [name, pattern] of Object.entries(oldMemory.workspacePatterns)) {
      const patternId = `pat_${crypto.randomUUID()}`;
      newMemory.workspacePatterns[patternId] = {
        patternId,
        names: { [name]: pattern.frequency || 1 },
        domains: pattern.domains || [],
        categories: [],
        confidence: pattern.confidence || INITIAL_CONFIDENCE,
        frequency: pattern.frequency || 1,
        lastSeen: pattern.lastSeen || Date.now(),
      };
      idx++;
    }
  }

  if (oldMemory.namingPreferences) {
    for (const [original, pref] of Object.entries(oldMemory.namingPreferences)) {
      const count = pref.count || 1;
      newMemory.namingPreferences[original] = {
        preferredName: pref.preferredName,
        confidence: clampConfidence(Math.min(count * 0.1 + 0.2, MAX_CONFIDENCE)),
        observations: count,
      };
    }
  }

  if (oldMemory.corrections) {
    newMemory.corrections = oldMemory.corrections.slice();
    pruneCorrections(newMemory);
  }

  if (oldMemory.statistics) {
    newMemory.statistics = { ...oldMemory.statistics };
  }

  newMemory.statistics.totalCorrections = newMemory.corrections.length;

  return newMemory;
}

function pruneDomainRules(memory) {
  const entries = Object.entries(memory.domainRules);
  if (entries.length <= MAX_DOMAIN_RULES) return;
  entries.sort((a, b) => {
    const aScore = a[1].confidence;
    const bScore = b[1].confidence;
    if (aScore !== bScore) return aScore - bScore;
    return (a[1].lastSeen || 0) - (b[1].lastSeen || 0);
  });
  const toRemove = entries.slice(0, entries.length - MAX_DOMAIN_RULES);
  for (const [domain] of toRemove) {
    delete memory.domainRules[domain];
  }
}

function pruneWorkspacePatterns(memory) {
  const entries = Object.entries(memory.workspacePatterns);
  if (entries.length <= MAX_WORKSPACE_PATTERNS) return;
  entries.sort((a, b) => {
    const aScore = a[1].confidence;
    const bScore = b[1].confidence;
    if (aScore !== bScore) return aScore - bScore;
    return (a[1].lastSeen || 0) - (b[1].lastSeen || 0);
  });
  const toRemove = entries.slice(0, entries.length - MAX_WORKSPACE_PATTERNS);
  for (const [id] of toRemove) {
    delete memory.workspacePatterns[id];
  }
}

function pruneNamingPreferences(memory) {
  const entries = Object.entries(memory.namingPreferences);
  if (entries.length <= MAX_NAMING_PREFERENCES) return;
  entries.sort((a, b) => {
    const aScore = a[1].confidence;
    const bScore = b[1].confidence;
    if (aScore !== bScore) return aScore - bScore;
    return 0;
  });
  const toRemove = entries.slice(0, entries.length - MAX_NAMING_PREFERENCES);
  for (const [key] of toRemove) {
    delete memory.namingPreferences[key];
  }
}

function detectCategoryInfo(domain) {
  const category = classifyDomain(domain);
  return category || null;
}

export const PreferenceService = {
  async initializePreferenceMemory() {
    const result = await chrome.storage.local.get(STORAGE_KEY);
    const existing = result[STORAGE_KEY];

    if (!existing) {
      await chrome.storage.local.set({ [STORAGE_KEY]: createDefaultMemory() });
      return;
    }

    if (existing.version < 2) {
      const migrated = migrateV1ToV2(existing);
      await chrome.storage.local.set({ [STORAGE_KEY]: migrated });
      return;
    }

    if (existing.version !== VERSION) {
      existing.version = VERSION;
      await chrome.storage.local.set({ [STORAGE_KEY]: existing });
    }
  },

  async getPreferenceMemory() {
    const result = await chrome.storage.local.get(STORAGE_KEY);
    const memory = result[STORAGE_KEY];
    if (!memory) return createDefaultMemory();
    if (memory.version < 2) return migrateV1ToV2(memory);
    return memory;
  },

  async savePreferenceMemory(memory) {
    memory.statistics.lastUpdated = Date.now();
    await chrome.storage.local.set({ [STORAGE_KEY]: memory });
  },

  async recordTabOrganization(groups) {
    const memory = await this.getPreferenceMemory();
    if (!memory.enabled) return;

    for (const group of groups) {
      const groupDomains = [];

      for (const tab of group.tabs) {
        const domain = extractDomain(tab.url);
        groupDomains.push(domain);

        const existing = memory.domainRules[domain];

        if (existing) {
          if (existing.preferredWorkspace === group.name) {
            existing.confidence = applyConfidence(existing.confidence, SIGNAL_ACCEPT);
          } else {
            logCorrection(memory, 'tab_move', {
              domain,
              from: existing.preferredWorkspace,
              to: group.name,
            });
            existing.preferredWorkspace = group.name;
            existing.confidence = applyConfidence(existing.confidence, SIGNAL_DOMAIN_MOVE);
          }
          existing.observations++;
          existing.lastSeen = Date.now();
          const cat = detectCategoryInfo(domain);
          if (cat && !existing.category) {
            existing.category = cat;
          }
        } else {
          const cat = detectCategoryInfo(domain);
          memory.domainRules[domain] = {
            preferredWorkspace: group.name,
            category: cat || undefined,
            confidence: applyConfidence(INITIAL_CONFIDENCE, SIGNAL_ACCEPT),
            observations: 1,
            lastSeen: Date.now(),
          };
          if (cat) {
            memory.categoryPreferences[domain] = { category: cat };
          }
        }
      }

      const uniqueDomains = [...new Set(groupDomains)];
      await this._updateWorkspacePattern(memory, group.name, uniqueDomains);
    }

    pruneDomainRules(memory);
    pruneCorrections(memory);
    await this.savePreferenceMemory(memory);
  },

  async _updateWorkspacePattern(memory, groupName, domains) {
    const categories = [
      ...new Set(domains.map((d) => detectCategoryInfo(d)).filter(Boolean)),
    ];

    const existingEntry = this._findMatchingPattern(memory.workspacePatterns, domains, groupName);

    if (existingEntry) {
      const domainSet = new Set([...existingEntry.domains, ...domains]);
      existingEntry.domains = [...domainSet];
      const mergedCategories = new Set([...existingEntry.categories, ...categories]);
      existingEntry.categories = [...mergedCategories];
      existingEntry.frequency++;
      existingEntry.confidence = applyConfidence(existingEntry.confidence, SIGNAL_ACCEPT);
      existingEntry.lastSeen = Date.now();

      const currentNames = Object.keys(existingEntry.names);
      const nameIndex = currentNames.findIndex(
        (n) => n.toLowerCase() === groupName.toLowerCase()
      );
      if (nameIndex !== -1) {
        existingEntry.names[currentNames[nameIndex]]++;
      } else {
        existingEntry.names[groupName] = 1;
      }
    } else {
      const patternId = `pat_${crypto.randomUUID()}`;
      memory.workspacePatterns[patternId] = {
        patternId,
        names: { [groupName]: 1 },
        domains,
        categories,
        confidence: INITIAL_CONFIDENCE,
        frequency: 1,
        lastSeen: Date.now(),
      };
    }
  },

  _findMatchingPattern(patterns, domains, name) {
    const domainSet = new Set(domains);
    let bestMatch = null;
    let bestScore = 0;

    for (const pattern of Object.values(patterns)) {
      const patternDomainSet = new Set(pattern.domains);
      const intersection = [...domainSet].filter((d) => patternDomainSet.has(d)).length;
      const union = new Set([...domainSet, ...patternDomainSet]).size;
      const jaccard = union > 0 ? intersection / union : 0;

      const nameMatch = Object.keys(pattern.names).some(
        (n) => n.toLowerCase() === name.toLowerCase()
      );

      let score = jaccard;
      if (nameMatch) score += 0.3;

      if (score > bestScore) {
        bestScore = score;
        bestMatch = pattern;
      }
    }

    return bestScore > 0.3 ? bestMatch : null;
  },

  async recordWorkspaceRename(oldName, newName) {
    const memory = await this.getPreferenceMemory();
    if (!memory.enabled) return;

    const existing = memory.namingPreferences[oldName];
    if (existing) {
      if (existing.preferredName === newName) {
        existing.confidence = applyConfidence(existing.confidence, SIGNAL_WORKSPACE_RENAME);
        existing.observations++;
      } else {
        existing.preferredName = newName;
        existing.confidence = applyConfidence(
          clampConfidence(existing.confidence * 0.5),
          SIGNAL_WORKSPACE_RENAME
        );
        existing.observations++;
      }
    } else {
      memory.namingPreferences[oldName] = {
        preferredName: newName,
        confidence: applyConfidence(INITIAL_CONFIDENCE, SIGNAL_WORKSPACE_RENAME),
        observations: 1,
      };
    }

    logCorrection(memory, 'workspace_rename', { oldName, newName });
    pruneNamingPreferences(memory);
    pruneCorrections(memory);
    await this.savePreferenceMemory(memory);
  },

  async recordTabMove(domain, fromWorkspace, toWorkspace) {
    const memory = await this.getPreferenceMemory();
    if (!memory.enabled) return;

    const existing = memory.domainRules[domain];
    if (existing) {
      existing.preferredWorkspace = toWorkspace;
      existing.confidence = applyConfidence(INITIAL_CONFIDENCE, SIGNAL_DOMAIN_MOVE);
      existing.observations++;
      existing.lastSeen = Date.now();
      const cat = detectCategoryInfo(domain);
      if (cat && !existing.category) {
        existing.category = cat;
        memory.categoryPreferences[domain] = { category: cat };
      }
    } else {
      const cat = detectCategoryInfo(domain);
      memory.domainRules[domain] = {
        preferredWorkspace: toWorkspace,
        category: cat || undefined,
        confidence: applyConfidence(INITIAL_CONFIDENCE, SIGNAL_DOMAIN_MOVE),
        observations: 1,
        lastSeen: Date.now(),
      };
      if (cat) {
        memory.categoryPreferences[domain] = { category: cat };
      }
    }

    logCorrection(memory, 'tab_move', { domain, from: fromWorkspace, to: toWorkspace });
    pruneDomainRules(memory);
    pruneCorrections(memory);
    await this.savePreferenceMemory(memory);
  },

  async recordWorkspaceDeletion(workspaceName) {
    const memory = await this.getPreferenceMemory();
    if (!memory.enabled) return;

    for (const pattern of Object.values(memory.workspacePatterns)) {
      const nameMatch = Object.keys(pattern.names).some(
        (n) => n.toLowerCase() === workspaceName.toLowerCase()
      );
      if (nameMatch) {
        pattern.confidence = applyConfidence(pattern.confidence, SIGNAL_DELETE_IMMEDIATE);
        if (pattern.confidence <= MIN_CONFIDENCE) {
          delete memory.workspacePatterns[pattern.patternId];
        }
        break;
      }
    }

    logCorrection(memory, 'workspace_delete', { workspaceName });
    pruneCorrections(memory);
    await this.savePreferenceMemory(memory);
  },

  async recordWorkspaceMerge(sourceWorkspaces, targetWorkspace) {
    const memory = await this.getPreferenceMemory();
    if (!memory.enabled) return;

    const mergedDomains = [];

    for (const source of sourceWorkspaces) {
      for (const pattern of Object.values(memory.workspacePatterns)) {
        const nameMatch = Object.keys(pattern.names).some(
          (n) => n.toLowerCase() === source.toLowerCase()
        );
        if (nameMatch) {
          mergedDomains.push(...pattern.domains);
          pattern.confidence = applyConfidence(pattern.confidence, SIGNAL_DELETE_IMMEDIATE);
          break;
        }
      }
    }

    const targetEntry = this._findMatchingPattern(
      memory.workspacePatterns,
      mergedDomains,
      targetWorkspace
    );

    if (targetEntry) {
      const domainSet = new Set([...targetEntry.domains, ...mergedDomains]);
      targetEntry.domains = [...domainSet];
      targetEntry.frequency++;
      targetEntry.confidence = applyConfidence(targetEntry.confidence, SIGNAL_WORKSPACE_MERGE);
      targetEntry.lastSeen = Date.now();
      if (!Object.keys(targetEntry.names).some((n) => n.toLowerCase() === targetWorkspace.toLowerCase())) {
        targetEntry.names[targetWorkspace] = 1;
      }
    } else {
      const patternId = `pat_${crypto.randomUUID()}`;
      memory.workspacePatterns[patternId] = {
        patternId,
        names: { [targetWorkspace]: 1 },
        domains: [...new Set(mergedDomains)],
        categories: [],
        confidence: applyConfidence(INITIAL_CONFIDENCE, SIGNAL_WORKSPACE_MERGE),
        frequency: 1,
        lastSeen: Date.now(),
      };
    }

    logCorrection(memory, 'workspace_merge', { sourceWorkspaces, targetWorkspace });
    pruneWorkspacePatterns(memory);
    pruneCorrections(memory);
    await this.savePreferenceMemory(memory);
  },

  async applyConfidenceDecay() {
    const memory = await this.getPreferenceMemory();
    const now = Date.now();
    const lastDecay = memory.statistics.lastDecayApplied;

    if (lastDecay) {
      const daysSinceDecay = (now - lastDecay) / (1000 * 60 * 60 * 24);
      if (daysSinceDecay < DECAY_INTERVAL_DAYS) return;
    }

    const daysSinceDecay = lastDecay
      ? (now - lastDecay) / (1000 * 60 * 60 * 24)
      : DECAY_INTERVAL_DAYS;
    const periodsElapsed = Math.floor(daysSinceDecay / DECAY_INTERVAL_DAYS);

    if (periodsElapsed <= 0) return;

    const decayMultiplier = Math.pow(DECAY_FACTOR, periodsElapsed);

    for (const domain of Object.keys(memory.domainRules)) {
      memory.domainRules[domain].confidence = clampConfidence(
        memory.domainRules[domain].confidence * decayMultiplier
      );
    }

    for (const id of Object.keys(memory.workspacePatterns)) {
      memory.workspacePatterns[id].confidence = clampConfidence(
        memory.workspacePatterns[id].confidence * decayMultiplier
      );
    }

    memory.statistics.lastDecayApplied = now;
    await this.savePreferenceMemory(memory);
  },

  async generatePreferenceHints() {
    const memory = await this.getPreferenceMemory();
    const sections = [];

    // Domain rules (confidence > 0.60)
    const domainEntries = Object.entries(memory.domainRules)
      .filter(([, rule]) => rule.confidence > LOW_CONFIDENCE_THRESHOLD)
      .sort((a, b) => b[1].confidence - a[1].confidence)
      .slice(0, 20);

    if (domainEntries.length > 0) {
      const lines = domainEntries.map(
        ([domain, rule]) =>
          `${domain} → ${rule.preferredWorkspace} (Confidence: ${rule.confidence.toFixed(2)})`
      );
      sections.push('Domain Preferences:\n' + lines.join('\n'));
    }

    // Category preferences
    const categoryDomains = {};
    for (const [domain, rule] of Object.entries(memory.domainRules)) {
      if (rule.category && rule.confidence > LOW_CONFIDENCE_THRESHOLD) {
        if (!categoryDomains[rule.category]) {
          categoryDomains[rule.category] = [];
        }
        categoryDomains[rule.category].push(domain);
      }
    }

    if (Object.keys(categoryDomains).length > 0) {
      const lines = Object.entries(categoryDomains)
        .slice(0, 8)
        .map(([cat, domains]) => {
          const formatted = cat.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
          return `${formatted}:\n${domains.map((d) => `  ${d}`).join('\n')}`;
        });
      sections.push('Category Preferences:\n' + lines.join('\n\n'));
    }

    // Naming preferences (observations >= 2)
    const namingEntries = Object.entries(memory.namingPreferences)
      .filter(([, pref]) => pref.observations >= 2 && pref.confidence > LOW_CONFIDENCE_THRESHOLD);

    if (namingEntries.length > 0) {
      const lines = namingEntries.map(
        ([original, pref]) =>
          `${original} → ${pref.preferredName}`
      );
      sections.push('Naming Preferences:\n' + lines.join('\n'));
    }

    // Workspace patterns (confidence > 0.70)
    const patternEntries = Object.values(memory.workspacePatterns)
      .filter((pattern) => pattern.confidence > HIGH_CONFIDENCE_THRESHOLD)
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 5);

    if (patternEntries.length > 0) {
      const lines = patternEntries.map((pattern) => {
        const topNames = Object.entries(pattern.names)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([n]) => n);
        return `Pattern: ${topNames.join(' / ')}\nCommon Domains:\n${pattern.domains.slice(0, 10).map((d) => `  ${d}`).join('\n')}`;
      });
      sections.push('Workspace Patterns:\n' + lines.join('\n\n'));
    }

    if (sections.length === 0) return '';

    return 'User Historical Preferences:\n\n' + sections.join('\n\n');
  },

  async getDomainPreference(domain) {
    const memory = await this.getPreferenceMemory();
    const rule = memory.domainRules[domain];
    if (!rule) return null;
    return { workspace: rule.preferredWorkspace, confidence: rule.confidence };
  },

  async getPreferenceStats() {
    const memory = await this.getPreferenceMemory();
    return {
      enabled: memory.enabled,
      domainRuleCount: Object.keys(memory.domainRules).length,
      workspacePatternCount: Object.keys(memory.workspacePatterns).length,
      namingPreferenceCount: Object.keys(memory.namingPreferences).length,
      categoryPreferenceCount: Object.keys(memory.categoryPreferences).length,
      totalCorrections: memory.statistics.totalCorrections,
      lastUpdated: memory.statistics.lastUpdated,
      lastDecayApplied: memory.statistics.lastDecayApplied,
    };
  },

  async clearPreferenceMemory() {
    await this.savePreferenceMemory(createDefaultMemory());
  },

  async exportPreferenceMemory() {
    return this.getPreferenceMemory();
  },

  async importPreferenceMemory(importedMemory) {
    if (!importedMemory) return;

    const memory = await this.getPreferenceMemory();

    if (importedMemory.domainRules) {
      for (const [domain, imported] of Object.entries(importedMemory.domainRules)) {
        const existing = memory.domainRules[domain];
        if (!existing || imported.confidence > existing.confidence) {
          memory.domainRules[domain] = imported;
        }
      }
    }

    if (importedMemory.categoryPreferences) {
      for (const [domain, imported] of Object.entries(importedMemory.categoryPreferences)) {
        if (!memory.categoryPreferences[domain]) {
          memory.categoryPreferences[domain] = imported;
        }
      }
    }

    if (importedMemory.workspacePatterns) {
      for (const [id, imported] of Object.entries(importedMemory.workspacePatterns)) {
        const existing = memory.workspacePatterns[id];
        if (!existing) {
          memory.workspacePatterns[id] = imported;
        } else {
          if (imported.confidence > existing.confidence) {
            existing.confidence = imported.confidence;
          }
          const domainSet = new Set([...existing.domains, ...imported.domains]);
          existing.domains = [...domainSet];
          for (const [name, count] of Object.entries(imported.names || {})) {
            existing.names[name] = (existing.names[name] || 0) + count;
          }
        }
      }
    }

    if (importedMemory.namingPreferences) {
      for (const [original, imported] of Object.entries(importedMemory.namingPreferences)) {
        const existing = memory.namingPreferences[original];
        if (!existing || imported.observations > existing.observations) {
          memory.namingPreferences[original] = imported;
        }
      }
    }

    if (importedMemory.corrections) {
      const existingIds = new Set(memory.corrections.map((c) => c.id));
      for (const correction of importedMemory.corrections) {
        if (!existingIds.has(correction.id)) {
          memory.corrections.push(correction);
        }
      }
      pruneCorrections(memory);
    }

    pruneDomainRules(memory);
    pruneWorkspacePatterns(memory);
    pruneNamingPreferences(memory);
    await this.savePreferenceMemory(memory);
  },

  async setEnabled(enabled) {
    const memory = await this.getPreferenceMemory();
    memory.enabled = enabled;
    await this.savePreferenceMemory(memory);
  },

  async getEnabled() {
    const memory = await this.getPreferenceMemory();
    return memory.enabled;
  },
};
