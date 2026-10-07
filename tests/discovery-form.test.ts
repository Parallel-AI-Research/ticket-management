import assert from "node:assert/strict";
import { test } from "node:test";
import {
  discoveryHtml,
  parseDeclarationForm,
  parseDiscoveryForm,
  renderDiscoveryPolicyPage,
} from "../src/lib/research/discovery-form";

test("form declaration uses the same schema and rejects ambiguous or extra fields", () => {
  const base = "agentName=Codex&actingFor=R17&sources=current_website&sources=user_instruction";
  assert.equal(parseDeclarationForm(base).success, true);
  for (const invalid of [
    "",
    base + "&nonce=private",
    base + "&agentName=Other",
    base.replace("R17", ""),
    base.replaceAll("sources=", "other="),
    base.replace("current_website", "private_prompt"),
  ]) {
    assert.equal(parseDeclarationForm(invalid).success, false);
  }
  assert.equal(
    parseDeclarationForm("agentName=Unknown&actingFor=Not+disclosed&sources=unknown").success,
    true,
  );
});

test("visual variants share instructions and only V2 adds an explicit blank form", async () => {
  const v1 = renderDiscoveryPolicyPage("v1"),
    v2 = renderDiscoveryPolicyPage("v2");
  assert.equal(v1.includes("<form"), false);
  assert.equal(v2.includes('method="post" action="/api/agent-registration/form"'), true);
  assert.equal(v2.includes(" checked"), false);
  assert.equal(v2.includes("<script"), false);
  assert.equal(v2.includes('name="agentName" value='), false);
  assert.equal(v2.includes('name="actingFor" value='), false);
  assert.equal(v1.includes("Declaration accepted"), false);
  assert.equal(v2.includes("Declaration accepted"), false);
  const accepted = renderDiscoveryPolicyPage("v2", "accepted");
  assert.equal(accepted.includes("Declaration accepted for this session"), true);
  assert.equal(accepted.includes("<form"), false);
  assert.equal(v1.slice(v1.indexOf("<h2>")), v2.slice(v2.indexOf("<h2>")));
  const response = discoveryHtml(accepted);
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  assert.match(response.headers.get("Content-Security-Policy")!, /form-action 'self'/);
});

test("form return variant is strictly allowlisted and never changes declaration fields", () => {
  const body = "agentName=Codex&actingFor=R17&sources=current_website";
  for (const variant of ["v2", "v3", "v4"]) {
    const parsed = parseDiscoveryForm(`${body}&variant=${variant}`);
    assert.equal(parsed.variant, variant);
    assert.equal(parsed.declaration.success, true);
    if (parsed.declaration.success)
      assert.deepEqual(Object.keys(parsed.declaration.data).sort(), [
        "actingFor",
        "agentName",
        "sources",
      ]);
  }
  for (const suffix of ["&variant=https://evil.test", "&variant=v1", "&variant=v3&variant=v2"])
    assert.equal(parseDiscoveryForm(body + suffix).declaration.success, false);
});
