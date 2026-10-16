'use strict';
/* Starter foods: typical fitness ingredients every account's food library starts with, so there is always
   something to pick. Values per 100 g (100 ml for milk) from USDA FoodData Central (SR Legacy); carbs
   include fibre, so they can read a little higher than a UK label. s = how the values are weighed
   ('raw' – dry for rice, pasta, grains and lentils – or '' when it isn't cooked or comes ready to eat);
   y = cooked weight as a % of raw, used to show the values per 100 g cooked. Yields are typical: meat
   and fish lose about a quarter of their weight, rice and pasta take up 2–3 times theirs in water. */
const STARTER=[
  /* protein */
  {id:'chicken-breast',n:'Chicken breast, skinless',k:120,p:22.5,c:0,f:2.6,s:'raw',y:75,g:'Meat and fish'},
  {id:'chicken-thigh',n:'Chicken thigh, skinless',k:121,p:19.7,c:0,f:4.1,s:'raw',y:75,g:'Meat and fish'},
  {id:'turkey-mince',n:'Turkey mince, 7% fat',k:150,p:18.7,c:0,f:8.3,s:'raw',y:75,g:'Meat and fish'},
  {id:'beef-mince',n:'Lean beef mince, 5% fat',k:137,p:21.4,c:0,f:5,s:'raw',y:75,g:'Meat and fish'},
  {id:'salmon',n:'Salmon fillet',k:208,p:20.4,c:0,f:13.4,s:'raw',y:80,g:'Meat and fish'},
  {id:'cod',n:'Cod fillet',k:82,p:17.8,c:0,f:0.7,s:'raw',y:80,g:'Meat and fish'},
  {id:'tuna',n:'Tuna in water, drained',k:116,p:25.5,c:0,f:0.8,s:'',g:'Meat and fish'},
  {id:'egg',n:'Whole egg',k:143,p:12.6,c:0.7,f:9.5,s:'',g:'Eggs and dairy'},
  {id:'egg-white',n:'Egg whites',k:52,p:10.9,c:0.7,f:0.2,s:'',g:'Eggs and dairy'},
  {id:'greek-yoghurt',n:'Greek yoghurt, 0% fat',k:59,p:10.2,c:3.6,f:0.4,s:'',g:'Eggs and dairy'},
  {id:'cottage-cheese',n:'Cottage cheese, low fat',k:72,p:12.4,c:2.7,f:1,s:'',g:'Eggs and dairy'},
  {id:'milk',n:'Semi-skimmed milk',u:'ml',k:47,p:3.5,c:4.8,f:1.7,s:'',g:'Eggs and dairy'},
  {id:'whey',n:'Whey protein powder',k:400,p:78,c:8,f:6,s:'',g:'Eggs and dairy',note:'Brands vary a lot – check your tub.'},
  {id:'tofu',n:'Tofu, firm',k:144,p:17.3,c:2.8,f:8.7,s:'',g:'Plant protein'},
  {id:'lentils',n:'Red lentils',k:352,p:24.6,c:63.4,f:1.1,s:'raw',y:300,g:'Plant protein'},
  /* carbs */
  {id:'white-rice',n:'White rice',k:365,p:7.1,c:80,f:0.7,s:'raw',y:280,g:'Grains and potatoes'},
  {id:'brown-rice',n:'Brown rice',k:370,p:7.9,c:77.2,f:2.9,s:'raw',y:300,g:'Grains and potatoes'},
  {id:'pasta',n:'Pasta',k:371,p:13,c:74.7,f:1.5,s:'raw',y:235,g:'Grains and potatoes'},
  {id:'quinoa',n:'Quinoa',k:368,p:14.1,c:64.2,f:6.1,s:'raw',y:300,g:'Grains and potatoes'},
  {id:'oats',n:'Rolled oats',k:379,p:13.2,c:67.7,f:6.5,s:'',g:'Grains and potatoes'},
  {id:'potato',n:'Potatoes, peeled',k:77,p:2,c:17,f:0.1,s:'raw',y:90,g:'Grains and potatoes'},
  {id:'sweet-potato',n:'Sweet potato',k:86,p:1.6,c:20.1,f:0.1,s:'raw',y:95,g:'Grains and potatoes'},
  {id:'wholemeal-bread',n:'Wholemeal bread',k:252,p:12.5,c:42.7,f:3.5,s:'',g:'Grains and potatoes'},
  {id:'rice-cakes',n:'Rice cakes',k:387,p:8.2,c:81.5,f:2.8,s:'',g:'Grains and potatoes'},
  /* fruit and veg */
  {id:'banana',n:'Banana, peeled',k:89,p:1.1,c:22.8,f:0.3,s:'',g:'Fruit and veg'},
  {id:'blueberries',n:'Blueberries',k:57,p:0.7,c:14.5,f:0.3,s:'',g:'Fruit and veg'},
  {id:'apple',n:'Apple',k:52,p:0.3,c:13.8,f:0.2,s:'',g:'Fruit and veg'},
  {id:'broccoli',n:'Broccoli',k:34,p:2.8,c:6.6,f:0.4,s:'',g:'Fruit and veg'},
  {id:'spinach',n:'Spinach',k:23,p:2.9,c:3.6,f:0.4,s:'',g:'Fruit and veg'},
  {id:'red-pepper',n:'Red pepper',k:31,p:1,c:6,f:0.3,s:'',g:'Fruit and veg'},
  /* fats */
  {id:'avocado',n:'Avocado',k:160,p:2,c:8.5,f:14.7,s:'',g:'Fats'},
  {id:'olive-oil',n:'Olive oil',k:884,p:0,c:0,f:100,s:'',g:'Fats'},
  {id:'peanut-butter',n:'Peanut butter',k:588,p:25,c:20,f:50,s:'',g:'Fats'},
  {id:'almonds',n:'Almonds',k:579,p:21.2,c:21.6,f:49.9,s:'',g:'Fats'},
];
