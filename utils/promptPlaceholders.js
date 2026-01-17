import { characters, this_chid } from '/script.js';
import { power_user } from '/scripts/power-user.js';

function safeTrim(value) {
    return String(value ?? '').trim();
}

function getActiveCharacter(context) {
    const chid = typeof this_chid === 'number' ? this_chid : context?.characterId;
    if (chid === undefined || chid === null) return null;

    const fromGlobal = characters?.[chid];
    if (fromGlobal) return fromGlobal;

    const fromContext = context?.characters?.[chid];
    if (fromContext) return fromContext;

    return null;
}

export function getPromptPlaceholderReplacements(context) {
    const userDescription = safeTrim(
        context?.powerUserSettings?.persona_description ??
        power_user?.persona_description ??
        globalThis?.power_user?.persona_description
    );

    const character = getActiveCharacter(context);
    const characterDescription = safeTrim(
        character?.description ??
        character?.data?.description ??
        context?.name2_description
    );

    return {
        $U: userDescription,
        $C: characterDescription,
    };
}
