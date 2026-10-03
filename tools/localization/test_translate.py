import importlib.util
import json
import pathlib
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('translation', pathlib.Path(__file__).with_name('translate.py'))
translation = importlib.util.module_from_spec(spec)
spec.loader.exec_module(translation)


class TranslationValidationTests(unittest.TestCase):
    def test_all_raw_resources_have_complete_translations(self):
        self.assertEqual(set(translation.validate_all()), set(translation.LOCALES))

    def test_runtime_layout_has_one_authoritative_directory(self):
        self.assertEqual(sorted(path.name for path in translation.DIRECTORY.glob('*.json')), sorted(locale + '.json' for locale in translation.LOCALES))
        self.assertFalse(list(translation.ROOT.joinpath('packages/shared/src/lang').glob('ui/*.json')))
        self.assertFalse(list(translation.ROOT.joinpath('apps/web/src/locales').glob('*.json')))

    def test_rejects_duplicate_keys_and_flat_resources(self):
        with self.assertRaises(ValueError):
            json.loads('{"save":"Save","save":"Guardar"}', object_pairs_hook=translation.unique_object)
        with self.assertRaises(ValueError):
            translation.flatten({'common.save': 'Save'})

    def test_rejects_wrong_language_and_missing_parameters(self):
        with self.assertRaises(ValueError):
            translation.validate('zh_CN', {'security.bind': 'Enlazar'}, {'security.bind': 'Connect'})
        with self.assertRaises(ValueError):
            translation.validate('en', {'hello': 'Hello'}, {'hello': 'Hello {name}'})
        with self.assertRaises(ValueError):
            translation.validate('en', {'hello': 'Hello :name'}, {'hello': 'Hello {name}'})

    def test_preserves_named_parameters_and_plural_branches(self):
        translation.validate('zh_CN', {'count': '{count} 项'}, {'count': '{count} item | {count} items'})

    def test_failed_generation_never_silently_returns_english(self):
        with patch.object(translation.subprocess, 'check_output', return_value='invalid-json'):
            with self.assertRaises(ValueError):
                translation.translate_batch(['Save {name}'], 'en', 'zh-CN')


if __name__ == '__main__':
    unittest.main()
