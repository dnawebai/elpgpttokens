import { describe, it, expect } from 'vitest';
import { classifyIntent, foldText, isElpIntent, type ElpIntent } from '../../services/intent.js';

function intentOf(text: string, signals?: Parameters<typeof classifyIntent>[1]): ElpIntent {
  return classifyIntent(text, signals).intent;
}

describe('classifyIntent', () => {
  describe('web search (routes to a web-grounded model)', () => {
    it.each([
      'search for the best restaurants in Madrid',
      'what is the latest news about the Fed?',
      'who won the game last night? search it',
      'busca las últimas noticias de Venezuela',
      'pesquisar o preço de bitcoin hoje',
      'price of gold today',
      'what happened at the 2026 world cup final',
      'weather forecast for Miami this week',
    ])('%s', (text) => {
      expect(intentOf(text)).toBe('web_search');
    });
  });

  describe('image generation (routes to an image model)', () => {
    it.each([
      'create an image of a cat astronaut on Mars',
      'generate a logo for my coffee shop',
      'draw a dragon in watercolor style',
      'crea una imagen de un perro con sombrero',
      'hazme un logo para mi empresa',
      'gere uma imagem de uma praia ao pôr do sol',
      'a photorealistic portrait of an old fisherman, cinematic lighting',
      '/image sunset over the andes',
    ])('%s', (text) => {
      expect(intentOf(text)).toBe('image_generation');
    });

    it('does not mistake an HTML question for image generation', () => {
      expect(intentOf('how do I create an image tag in HTML?')).toBe('code');
      expect(intentOf('resize an image in python with Pillow')).toBe('code');
    });

    it('keeps short follow-ups on the image route', () => {
      expect(intentOf('make it darker and add a moon', { previousIntent: 'image_generation' })).toBe('image_generation');
      expect(intentOf('otra versión más colorida', { previousIntent: 'image_generation' })).toBe('image_generation');
    });

    it('does not keep the image route for an unrelated follow-up', () => {
      expect(intentOf('now write a python function that sorts a list', { previousIntent: 'image_generation' })).toBe('code');
    });
  });

  describe('translation', () => {
    it.each([
      ['translate "good morning, how are you?" to Spanish', 'es'],
      ['traduce esto al inglés: ¿dónde está la estación?', 'en'],
      ['how do you say "thank you" in Japanese', 'ja'],
      ['traduza para o francês: bom dia', 'fr'],
    ])('%s', (text, lang) => {
      const result = classifyIntent(text);
      expect(result.intent).toBe('translation');
      expect(result.targetLanguage).toBe(lang);
    });

    it('lets an explicit translate verb beat code-looking content', () => {
      expect(intentOf('translate this error message to Spanish: TypeError: x is undefined')).toBe('translation');
    });
  });

  describe('code', () => {
    it.each([
      'fix this bug in my React component',
      'TypeError: Cannot read properties of undefined (reading "map")',
      '```js\nconst a = 1\n```\nwhy does this fail?',
      'write a SQL query to get the top 10 customers',
      'what is the current directory command in bash',
      'escribe una función en python que ordene una lista',
    ])('%s', (text) => {
      expect(intentOf(text)).toBe('code');
    });
  });

  describe('reasoning', () => {
    it.each([
      'solve x^2 + 5x + 6 = 0 step by step',
      'compare the pros and cons of renting vs buying a house',
      'resuelve esta ecuación: 3x + 2 = 11',
      'what is the probability of rolling two sixes',
    ])('%s', (text) => {
      expect(intentOf(text)).toBe('reasoning');
    });
  });

  describe('writing', () => {
    it.each([
      'write a short poem about the ocean',
      'draft an email to my landlord about the broken heater',
      'redacta un correo para mi jefe pidiendo vacaciones',
      'summarize this article for me',
    ])('%s', (text) => {
      expect(intentOf(text)).toBe('writing');
    });
  });

  describe('vision', () => {
    it('routes an attached image without a generation request to vision', () => {
      expect(intentOf('what is in this picture?', { hasImageAttachment: true })).toBe('vision');
      expect(intentOf('', { hasImageAttachment: true })).toBe('vision');
    });

    it('still generates when the user asks for a new image with a reference attached', () => {
      expect(intentOf('create an image like this one but at night', { hasImageAttachment: true })).toBe('image_generation');
    });
  });

  describe('chat (default)', () => {
    it.each([
      'hello!',
      'hola, ¿cómo estás?',
      'tell me a joke',
      'what do you think about pineapple on pizza',
      'the actual reason I asked is curiosity',
    ])('%s', (text) => {
      expect(intentOf(text)).toBe('chat');
    });

    it('treats empty input as chat with low confidence', () => {
      const result = classifyIntent('   ');
      expect(result).toMatchObject({ intent: 'chat', reason: 'empty' });
      expect(result.confidence).toBeLessThan(0.5);
    });
  });

  it('gives explicit commands full confidence', () => {
    expect(classifyIntent('/search tesla earnings')).toMatchObject({ intent: 'web_search', confidence: 1, reason: 'command:/search' });
  });

  it('reports the matched phrase as the reason', () => {
    expect(classifyIntent('busca noticias de hoy').reason).toMatch(/^keyword:/);
  });

  it('is deterministic', () => {
    const text = 'search the latest AI news and write a summary';
    expect(classifyIntent(text)).toEqual(classifyIntent(text));
  });
});

describe('foldText', () => {
  it('strips accents and lower-cases', () => {
    expect(foldText('Búsqueda ÚLTIMAS Traducción')).toBe('busqueda ultimas traduccion');
  });
});

describe('isElpIntent', () => {
  it('accepts known intents only', () => {
    expect(isElpIntent('web_search')).toBe(true);
    expect(isElpIntent('nope')).toBe(false);
    expect(isElpIntent(3)).toBe(false);
  });
});
