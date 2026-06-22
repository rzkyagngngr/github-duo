const INTROSPECTION_QUERY = `query GitLabDuoAdapterSchemaSearch {
  __schema {
    mutationType { name fields { name args { name type { kind name ofType { kind name ofType { kind name ofType { kind name } } } } } type { kind name ofType { kind name } } } }
    queryType { name fields { name args { name type { kind name ofType { kind name ofType { kind name ofType { kind name } } } } } type { kind name ofType { kind name } } } }
    types {
      kind
      name
      fields { name args { name type { kind name ofType { kind name ofType { kind name ofType { kind name } } } } } type { kind name ofType { kind name } } }
      inputFields { name type { kind name ofType { kind name ofType { kind name ofType { kind name } } } } }
      enumValues { name }
    }
  }
}`;

const DEFAULT_TERMS = [
  "duo",
  "workflow",
  "checkpoint",
  "agent",
  "chat",
  "ai"
];

export class GitLabGraphqlSchemaProbe {
  constructor(options = {}) {
    this.options = options || {};
  }

  isConfigured() {
    return Boolean(this.options.graphqlUrl && this.options.headers);
  }

  async search(terms = DEFAULT_TERMS) {
    if (!this.isConfigured()) {
      throw new Error("GraphQL checkpoint curl belum dikonfigurasi. Paste curl api/graphql di halaman /.");
    }

    const response = await fetch(this.options.graphqlUrl, {
      method: "POST",
      headers: {
        Accept: "*/*",
        "Content-Type": "application/json",
        ...(this.options.headers || {})
      },
      body: JSON.stringify({
        operationName: "GitLabDuoAdapterSchemaSearch",
        variables: {},
        query: INTROSPECTION_QUERY
      })
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`GraphQL introspection failed (${response.status}): ${text.slice(0, 1000)}`);
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`GraphQL introspection returned non-JSON: ${text.slice(0, 1000)}`);
    }

    if (data.errors?.length) {
      throw new Error(`GraphQL introspection errors: ${JSON.stringify(data.errors).slice(0, 2000)}`);
    }

    return filterSchema(data.data?.__schema, terms);
  }
}

function filterSchema(schema, terms) {
  const normalizedTerms = terms.map((term) => String(term).toLowerCase()).filter(Boolean);
  const mutationFields = filterFields(schema?.mutationType?.fields || [], normalizedTerms);
  const queryFields = filterFields(schema?.queryType?.fields || [], normalizedTerms);
  const types = (schema?.types || [])
    .filter((type) => matches(type, normalizedTerms))
    .map((type) => compactType(type));

  return {
    terms: normalizedTerms,
    mutationFields,
    queryFields,
    types: types.slice(0, 80)
  };
}

function filterFields(fields, terms) {
  return fields
    .filter((field) => matches(field, terms))
    .map((field) => ({
      name: field.name,
      args: (field.args || []).map((arg) => ({ name: arg.name, type: printType(arg.type) })),
      type: printType(field.type)
    }))
    .slice(0, 120);
}

function compactType(type) {
  return {
    kind: type.kind,
    name: type.name,
    fields: (type.fields || []).slice(0, 40).map((field) => ({
      name: field.name,
      args: (field.args || []).map((arg) => ({ name: arg.name, type: printType(arg.type) })),
      type: printType(field.type)
    })),
    inputFields: (type.inputFields || []).map((field) => ({
      name: field.name,
      type: printType(field.type)
    })),
    enumValues: (type.enumValues || []).map((value) => value.name)
  };
}

function matches(value, terms) {
  const haystack = JSON.stringify(value || {}).toLowerCase();
  return terms.some((term) => haystack.includes(term));
}

function printType(type) {
  if (!type) return "";
  if (type.kind === "NON_NULL") return `${printType(type.ofType)}!`;
  if (type.kind === "LIST") return `[${printType(type.ofType)}]`;
  return type.name || type.kind || "";
}
