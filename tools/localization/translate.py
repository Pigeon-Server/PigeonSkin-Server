import argparse
import concurrent.futures
import difflib
import json
import pathlib
import re
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
DIRECTORY = ROOT / 'packages/shared/src/locales'
LOCALES = ['zh_CN', 'zh_TW', 'en', 'es_ES', 'ru_RU', 'ja_JP']
TARGETS = {'zh_CN': 'zh-CN', 'zh_TW': 'zh-TW', 'en': 'en', 'es_ES': 'es', 'ru_RU': 'ru', 'ja_JP': 'ja'}


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f'Duplicate message key: {key}')
        result[key] = value
    return result


def flatten(data, prefix=''):
    result = {}
    for key, value in data.items():
        if '.' in key or key in ['__proto__', 'constructor', 'prototype']:
            raise ValueError(f'Invalid nested key: {prefix}{key}')
        if isinstance(value, dict):
            result.update(flatten(value, prefix + key + '.'))
        elif isinstance(value, str):
            result[prefix + key] = value
        else:
            raise ValueError(f'Message must be a string: {prefix}{key}')
    return result


def nested(messages):
    result = {}
    for key, value in messages.items():
        node = result
        parts = key.split('.')
        for part in parts[:-1]:
            node = node.setdefault(part, {})
        node[parts[-1]] = value
    return result


def messages(locale):
    return flatten(json.loads((DIRECTORY / f'{locale}.json').read_text(), object_pairs_hook=unique_object))


def variables(value):
    return sorted(set(re.findall(r'\{(\w+)\}', value)))


def validate(locale, data, reference, complete=True):
    if set(data) - set(reference) or (complete and set(data) != set(reference)):
        raise ValueError(f'{locale}: message keys do not match English')
    for key, value in data.items():
        if not value.strip() or variables(value) != variables(reference[key]):
            raise ValueError(f'{locale}:{key}: invalid content or placeholders')
        if re.search(r'(?<![\w]):[a-zA-Z_]\w*', value):
            raise ValueError(f'{locale}:{key}: Laravel placeholder is not supported')
    if locale in ['zh_CN', 'zh_TW', 'ja_JP', 'ru_RU'] and data:
        script = r'[㐀-鿿ぁ-ヿ]' if locale == 'ja_JP' else r'[А-яЁё]' if locale == 'ru_RU' else r'[㐀-鿿]'
        ratio = sum(bool(re.search(script, value)) for value in data.values()) / len(data)
        if ratio < 0.8:
            raise ValueError(f'{locale}: language feature ratio {ratio:.1%} is too low')
    if locale != 'en' and data:
        comparable = [key for key in data if re.search(r'[A-Za-z]{3}', reference[key])]
        duplicates = sum(data[key] == reference[key] for key in comparable)
        if comparable and duplicates / len(comparable) > 0.3:
            raise ValueError(f'{locale}: too many untranslated English messages')


def validate_all():
    legacy_runtime = [
        * (ROOT / 'packages/shared/src/lang').glob('ui/*.json'),
        * (ROOT / 'packages/shared/src/lang').glob('php/*.json'),
        * (ROOT / 'packages/shared/src/lang').glob('*.ts'),
        * (ROOT / 'apps/web/src/locales').glob('*.json'),
    ]
    if legacy_runtime:
        raise ValueError('legacy runtime locale files remain: ' + ', '.join(str(path.relative_to(ROOT)) for path in legacy_runtime))
    if sorted(path.name for path in DIRECTORY.glob('*.json')) != sorted(locale + '.json' for locale in LOCALES):
        raise ValueError('locale directory must contain exactly one JSON file per supported locale')
    dictionaries = {locale: messages(locale) for locale in LOCALES}
    for locale, data in dictionaries.items():
        validate(locale, data, dictionaries['en'])
    for locale in ['es_ES', 'ru_RU', 'ja_JP']:
        duplicates = sum(value == dictionaries[locale][key] for key, value in dictionaries['en'].items())
        if duplicates / len(dictionaries['en']) > 0.3:
            raise ValueError(f'en: content matches {locale}')
    return dictionaries


def shield(value):
    tokens = []
    def replace(match):
        marker = f'⟦{9000000000 + len(tokens)}⟧'
        tokens.append(match.group())
        return marker
    pattern = r"```[\s\S]*?```|\]\([^)]*\)|<[^>]+>|(?m:^#{1,6} )|\{[^{}]*\}|@(?:\.[\w]+)?:[\w.-]+|https?://[^\s]+|\||`[^`]*`|Minecraft|Pigeon Skin Server|CustomSkinLoader|Yggdrasil|authlib-injector|Mojang|Microsoft|OAuth|Cloudflare|WebAuthn|TOTP|Live2D|PNG|JSON|R2|D1|API"
    return re.sub(pattern, replace, value), tokens


def translate_batch(values, source, target):
    if not values:
        return []
    protected = [shield(value) for value in values]
    query = protected[0][0] if len(values) == 1 else '\n'.join(f'⟦{8000000000 + index}⟧\n{value}' for index, (value, _) in enumerate(protected))
    command = ['curl', '-fsSG', '--max-time', '45', '--retry', '2', 'https://translate.googleapis.com/translate_a/single']
    for key, value in {'client': 'gtx', 'sl': source, 'tl': target, 'dt': 't', 'q': query}.items():
        command.extend(['--data-urlencode', f'{key}={value}'])
    try:
        response = json.loads(subprocess.check_output(command, text=True))
        translated = ''.join(part[0] or '' for part in response[0])
        if len(values) == 1:
            segments = [translated.strip()]
        else:
            matches = list(re.finditer(r'⟦(8\d{9})⟧', translated))
            if [int(match.group(1)) - 8000000000 for match in matches] != list(range(len(values))):
                raise ValueError('Translation separators were changed')
            segments = [translated[match.end():matches[index + 1].start() if index + 1 < len(matches) else len(translated)].strip() for index, match in enumerate(matches)]
        result = []
        for value, (_, tokens), original in zip(segments, protected, values):
            for index, token in enumerate(tokens):
                marker = f'⟦{9000000000 + index}⟧'
                if value.count(marker) != 1:
                    raise ValueError('Translation token was changed')
                value = value.replace(marker, token)
            if variables(value) != variables(original):
                raise ValueError('Translation placeholders were changed')
            result.append(value)
        return result
    except (ValueError, subprocess.CalledProcessError, KeyError, IndexError):
        if len(values) == 1:
            raise
        middle = len(values) // 2
        return translate_batch(values[:middle], source, target) + translate_batch(values[middle:], source, target)


def patch_file(path, data):
    content = json.dumps(data, ensure_ascii=False, indent=2) + '\n'
    if path.exists():
        changes = list(difflib.unified_diff(path.read_text().splitlines(), content.splitlines(), n=3))[2:]
        if not changes:
            return ''
        return f'*** Update File: {path}\n' + ''.join(('@@' if line.startswith('@@') else line) + '\n' for line in changes)
    return f'*** Add File: {path}\n' + ''.join('+' + line + '\n' for line in content.splitlines())


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--locale', choices=LOCALES)
    parser.add_argument('--phase', choices=['validate', 'translate', 'manual', 'plan'], default='plan')
    parser.add_argument('--force', action='store_true')
    args = parser.parse_args()
    if args.phase == 'validate':
        dictionaries = validate_all()
        print(json.dumps({locale: len(data) for locale, data in dictionaries.items()}))
        return
    if not args.locale:
        parser.error('--locale is required')
    if args.phase == 'manual':
        if args.locale == 'zh_CN':
            parser.error('Simplified Chinese manual content is maintained as Markdown')
        sources = {path.stem: path.read_text() for path in (ROOT / 'apps/web/src/content/manual').glob('*.md')}
        def translate_document(content):
            result = []
            for section in re.split(r'(```[\s\S]*?```)', content):
                if section.startswith('```'):
                    result.append(section)
                    continue
                paragraphs = re.split(r'(\n\s*\n)', section)
                values = [part for index, part in enumerate(paragraphs) if index % 2 == 0 and part.strip()]
                translated = iter(translate_batch(values, 'zh-CN', TARGETS[args.locale]))
                result.extend(next(translated) if index % 2 == 0 and part.strip() else part for index, part in enumerate(paragraphs))
            return ''.join(result)
        with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
            translated = dict(zip(sources, pool.map(translate_document, sources.values())))
        patch = patch_file(ROOT / f'apps/web/src/content/manual/localized/{args.locale}.json', translated)
    else:
        reference = messages('en')
        existing = messages(args.locale)
        if not args.force:
            validate(args.locale, existing, reference, complete=False)
        pending = [(key, value) for key, value in reference.items() if args.force or key not in existing]
        if args.phase == 'plan':
            print(json.dumps({'locale': args.locale, 'total': len(reference), 'pending': len(pending)}))
            return
        if args.locale == 'en':
            parser.error('English is the translation source and must be edited directly')
        result = {} if args.force else dict(existing)
        batches = [pending[index:index + 12] for index in range(0, len(pending), 12)]
        def translate(items):
            return dict(zip([key for key, _ in items], translate_batch([value for _, value in items], 'en', TARGETS[args.locale])))
        with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
            for translated in pool.map(translate, batches):
                result.update(translated)
        validate(args.locale, result, reference)
        patch = patch_file(DIRECTORY / f'{args.locale}.json', nested(result))
    if patch:
        print('*** Begin Patch\n' + patch + '*** End Patch')


if __name__ == '__main__':
    main()
