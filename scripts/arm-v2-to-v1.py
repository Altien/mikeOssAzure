#!/usr/bin/env python3
"""Convert a Bicep-emitted ARM template from languageVersion 2.0 (symbolic-name
codegen, resources-as-object) to the legacy v1 form (resources-as-array).

Why this exists:
  Bicep automatically emits languageVersion 2.0 when the source uses any of
  several modern features (`@secure()` on outputs, `!` non-null assertion on
  conditional resources/modules, user-defined types, etc.). Azure Resource
  Manager itself accepts both forms, but the Partner Center marketplace
  uploader validates the package against the legacy 2019-04-01 schema, which
  insists on `resources: array`. Rejecting the package with:

      "Invalid type. Expected Array but got Object."

  Refactoring the source bicep to avoid every v2 trigger is invasive and ties
  our hands going forward; converting the JSON output is a contained, local
  fix that runs once during marketplace package builds.

What it does:
  1. Strips the top-level `languageVersion` (and from any nested deployment
     templates).
  2. Converts `resources: { symbol: resourceDef, ... }` → `resources: [...]`.
  3. Rewrites symbolic-name references inside ARM expressions:
       - `reference('symbol'...)`     → `reference(resourceId('type', name)...)`
       - `dependsOn: ['symbol', ...]` → `dependsOn: ['[resourceId(...)]', ...]`
  4. Recurses into nested module templates so they're converted too.

Usage:
  python arm-v2-to-v1.py <path-to-mainTemplate.json>

Idempotent — no-op when languageVersion is missing or already 1.x.
"""

from __future__ import annotations

import json
import re
import sys
from typing import Any


_REFERENCE_FN_RE = re.compile(
    # reference('symbol'             → group 1 = symbol
    # reference('symbol', '...')     → group 1 = symbol, group 2 = trailing args (incl leading comma)
    r"reference\('([A-Za-z_][A-Za-z0-9_]*)'(\s*(?:,[^)]*)?)\)"
)


def _name_expr(name_value: Any) -> str:
    """Return a fragment usable as the second arg to resourceId(): either a
    quoted literal or an inlined ARM-expression body."""
    if isinstance(name_value, str) and name_value.startswith("[") and name_value.endswith("]"):
        return name_value[1:-1]
    if isinstance(name_value, str):
        # Embed as a single-quoted literal; ARM expressions use single quotes.
        # Escape any literal single quotes by doubling, per ARM expression rules.
        return "'" + name_value.replace("'", "''") + "'"
    raise TypeError(f"Resource name must be a string, got {type(name_value).__name__}: {name_value!r}")


def _resource_id_expr(symbol_to_res: dict[str, dict], symbol: str) -> str:
    """Return an ARM expression body (no surrounding brackets) that resolves to
    the resource id of `symbol`."""
    r = symbol_to_res[symbol]
    return f"resourceId('{r['type']}', {_name_expr(r['name'])})"


def _rewrite_expression(body: str, symbol_to_res: dict[str, dict]) -> str:
    """Rewrite a single ARM-expression body (without brackets), replacing any
    symbolic-name references with explicit resourceId() calls."""

    def repl(m: re.Match) -> str:
        symbol = m.group(1)
        if symbol not in symbol_to_res:
            # Not one of ours — leave the expression alone (could legitimately
            # be a parameter or variable name that happens to match the regex,
            # though `reference('literal')` is unusual outside symbolic-name
            # codegen).
            return m.group(0)
        rid = _resource_id_expr(symbol_to_res, symbol)
        trailing = m.group(2) or ""
        return f"reference({rid}{trailing})"

    return _REFERENCE_FN_RE.sub(repl, body)


def _walk(value: Any, symbol_to_res: dict[str, dict]) -> Any:
    if isinstance(value, str):
        if value.startswith("[") and value.endswith("]"):
            return "[" + _rewrite_expression(value[1:-1], symbol_to_res) + "]"
        return value
    if isinstance(value, list):
        return [_walk(v, symbol_to_res) for v in value]
    if isinstance(value, dict):
        return {k: _walk(v, symbol_to_res) for k, v in value.items()}
    return value


def _convert_template(template: dict[str, Any]) -> dict[str, Any]:
    """Convert a single template (in place is fine, but we return for chaining).
    Recurses into any nested module templates under
    `resources[*].properties.template`."""
    if "languageVersion" not in template:
        # Nothing to do — already legacy form. Still recurse into nested
        # templates in case they have languageVersion:2.0 but the outer doesn't.
        if isinstance(template.get("resources"), list):
            for r in template["resources"]:
                nested = (r.get("properties") or {}).get("template")
                if isinstance(nested, dict):
                    _convert_template(nested)
        return template

    resources = template.get("resources")
    if not isinstance(resources, dict):
        # languageVersion=2.0 but resources is already a list — odd, leave it.
        del template["languageVersion"]
        return template

    symbol_to_res = dict(resources)

    new_resources: list[dict] = []
    for symbol, res in resources.items():
        # Walk the body to rewrite any reference('symbol', ...) calls.
        rewritten = _walk(res, symbol_to_res)
        # dependsOn entries are bare symbol strings, not ARM expressions — fix
        # them to `[resourceId(...)]` literals.
        if isinstance(rewritten, dict) and "dependsOn" in rewritten:
            rewritten["dependsOn"] = [
                f"[{_resource_id_expr(symbol_to_res, dep)}]" if dep in symbol_to_res else dep
                for dep in rewritten["dependsOn"]
            ]
        # Recurse into nested module templates.
        nested = (rewritten.get("properties") or {}).get("template") if isinstance(rewritten, dict) else None
        if isinstance(nested, dict):
            _convert_template(nested)
        new_resources.append(rewritten)

    template["resources"] = new_resources
    del template["languageVersion"]

    # Outputs may also contain reference('symbol') expressions — walk them.
    if isinstance(template.get("outputs"), dict):
        template["outputs"] = _walk(template["outputs"], symbol_to_res)

    return template


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(__doc__, file=sys.stderr)
        return 2
    path = argv[1]
    with open(path, "r", encoding="utf-8") as f:
        template = json.load(f)
    _convert_template(template)
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(template, f, indent=2)
        f.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
