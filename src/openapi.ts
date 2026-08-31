import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { registeredTools } from './tool-registry.js';
import { resolveBaseUrl } from './oauth/routes.js';

function zodTypeToOpenApi(zodType: z.ZodTypeAny): any {
  let type: z.ZodTypeAny = zodType;

  // Unwrap optional / default / nullable / effects
  while (
    type instanceof z.ZodOptional ||
    type instanceof z.ZodDefault ||
    type instanceof z.ZodNullable
  ) {
    if (type instanceof z.ZodOptional || type instanceof z.ZodNullable) {
      type = type.unwrap();
    } else if (type instanceof z.ZodDefault) {
      type = type._def.innerType;
    }
  }

  const description = zodType.description;
  const result: any = {};
  if (description) result.description = description;

  if (type instanceof z.ZodString) {
    result.type = 'string';
  } else if (type instanceof z.ZodNumber) {
    result.type = 'number';
  } else if (type instanceof z.ZodBoolean) {
    result.type = 'boolean';
  } else if (type instanceof z.ZodEnum) {
    result.type = 'string';
    result.enum = type._def.values;
  } else if (type instanceof z.ZodArray) {
    result.type = 'array';
    result.items = zodTypeToOpenApi(type._def.type);
  } else if (type instanceof z.ZodObject) {
    result.type = 'object';
    const props: Record<string, any> = {};
    const required: string[] = [];
    const shape = type.shape;
    for (const [k, v] of Object.entries(shape)) {
      props[k] = zodTypeToOpenApi(v as z.ZodTypeAny);
      if (!(v instanceof z.ZodOptional) && !(v instanceof z.ZodDefault)) {
        required.push(k);
      }
    }
    result.properties = props;
    if (required.length > 0) result.required = required;
  } else {
    result.type = 'string';
  }

  return result;
}

export function generateOpenApiSpec(baseUrl: string): any {
  const paths: Record<string, any> = {};

  for (const [name, tool] of registeredTools.entries()) {
    const requestSchema = zodTypeToOpenApi(tool.zodObject);

    paths[`/api/v1/tools/${name}`] = {
      post: {
        operationId: name,
        summary: tool.description,
        description: tool.description,
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: requestSchema,
            },
          },
        },
        responses: {
          '200': {
            description: 'Successful tool execution result',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    content: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          type: { type: 'string' },
                          text: { type: 'string' },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          '400': { description: 'Bad Request / Validation Error' },
          '401': { description: 'Unauthorized' },
          '500': { description: 'Tool Execution Failure' },
        },
      },
    };
  }

  return {
    openapi: '3.0.3',
    info: {
      title: 'remote-ai Coding Agent API',
      version: '0.1.0',
      description: 'ChatGPT Custom Actions OpenAPI specification for remote-ai Local Coding Agent MCP Server.',
    },
    servers: [
      {
        url: baseUrl,
        description: 'Primary MCP & REST API Server',
      },
    ],
    paths,
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'Token',
          description: 'Use your server\'s bearer secret (the raw value produced by `npm run generate-token`, verified against BEARER_TOKEN_HASH) or an OAuth access token.',
        },
      },
    },
    security: [
      {
        bearerAuth: [],
      },
    ],
  };
}

export function createOpenApiRouter(): Router {
  const router = Router();

  // ── OpenAPI 3.0 Specification Endpoint for ChatGPT ───────────────────────
  router.get('/openapi.json', (req: Request, res: Response) => {
    const baseUrl = resolveBaseUrl(req);
    res.json(generateOpenApiSpec(baseUrl));
  });

  // ── REST API Tool Execution Endpoint for ChatGPT Custom Actions ───────────
  router.post('/api/v1/tools/:toolName', async (req: Request, res: Response) => {
    const toolName = String(req.params['toolName']);
    const tool = registeredTools.get(toolName);

    if (!tool) {
      res.status(404).json({ error: 'not_found', message: `Tool "${toolName}" not found or disabled in current profile.` });
      return;
    }

    try {
      const parsedArgs = tool.zodObject.parse(req.body || {});
      const result = await tool.handler(parsedArgs);
      res.json(result);
    } catch (err: any) {
      if (err instanceof z.ZodError) {
        res.status(400).json({ error: 'invalid_arguments', details: err.errors });
      } else {
        res.status(500).json({ error: 'execution_error', message: err?.message || String(err) });
      }
    }
  });

  return router;
}
