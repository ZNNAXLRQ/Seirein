export const readJsonBody = (req) =>
    new Promise((resolve) => {
      let data = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => {
        data += chunk;
        if (data.length > 1_000_000) req.destroy();
      });
      req.on('end', () => {
        try {
          resolve(JSON.parse(data.length === 0 ? '{}' : data));
        } catch {
          resolve({});
        }
      });
      req.on('error', () => resolve({}));
    });
